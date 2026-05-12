import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import pc from 'picocolors';
import {
  browserAuthFlow,
  storeCredentials,
  loadCredentials,
  isTokenExpired,
  resolveTokenSource,
} from '../auth.js';
import { listProjects, createProject, createApiKey } from '../api-client.js';
import { generateContextFiles } from '../context-files.js';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type Framework = 'expo' | 'react-native' | 'web' | 'unknown';

async function detectFramework(cwd: string): Promise<Framework> {
  try {
    const pkgPath = join(cwd, 'package.json');
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = {
      ...(typeof pkg.dependencies === 'object' && pkg.dependencies !== null
        ? pkg.dependencies
        : {}),
      ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null
        ? pkg.devDependencies
        : {}),
    } as Record<string, string>;

    if ('expo' in deps) return 'expo';
    if ('react-native' in deps) return 'react-native';
    if ('react' in deps || 'next' in deps || 'vue' in deps || 'svelte' in deps) return 'web';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function getSdkPackage(framework: Framework): string {
  switch (framework) {
    case 'expo':
      return '@layers/amba-expo';
    case 'react-native':
      // No dedicated @layers/amba-react-native package yet — use the core SDK.
      return '@layers/amba-client';
    case 'web':
      return '@layers/amba-client';
    case 'unknown':
      return '@layers/amba-client';
  }
}

export interface InitOptions {
  withExample?: boolean;
  /**
   * The first `amba init` per developer mints a **personal dev** project
   * (free tier, separate billing class). Default environment for `init`
   * is therefore `'development'`. Pass `--env=production` to opt into a
   * production project at init time (rare — most production projects are
   * minted via `amba projects create --env production` by automation).
   */
  env?: 'development' | 'production';
}

async function writeExampleScaffold(
  cwd: string,
  framework: Framework,
  projectName: string,
): Promise<string[]> {
  const written: string[] = [];

  // Only scaffold into a project dir when the target file doesn't already exist
  // — we never overwrite user code.
  const appTsxPath = join(cwd, 'amba-example.tsx');
  if (!(await fileExists(appTsxPath))) {
    const appTsx =
      framework === 'expo'
        ? `/**
 * Amba example — ${projectName}
 *
 * Drop this into your Expo app (e.g. app/_layout.tsx) to initialize Amba
 * once at startup. Requires: process.env.EXPO_PUBLIC_AMBA_PROJECT_ID
 *                           process.env.EXPO_PUBLIC_AMBA_API_KEY
 */
import { useEffect } from 'react';
import { Amba } from '@layers/amba-expo';

export function AmbaExample(): null {
  useEffect(() => {
    void Amba.init({
      projectId: process.env.EXPO_PUBLIC_AMBA_PROJECT_ID!,
      apiKey: process.env.EXPO_PUBLIC_AMBA_API_KEY!,
    });
  }, []);
  return null;
}
`
        : `/**
 * Amba example — ${projectName}
 *
 * Call Amba.init() once at application startup (after env is loaded).
 * Requires AMBA_PROJECT_ID + AMBA_API_KEY in your environment.
 */
import { Amba } from '@layers/amba-client';

export async function initAmba(): Promise<void> {
  await Amba.init({
    projectId: process.env.AMBA_PROJECT_ID!,
    apiKey: process.env.AMBA_API_KEY!,
  });
}
`;
    await writeFile(appTsxPath, appTsx, 'utf-8');
    written.push('amba-example.tsx');
  }

  const readmeSnippetPath = join(cwd, 'AMBA_QUICKSTART.md');
  if (!(await fileExists(readmeSnippetPath))) {
    const readme = `# Amba quickstart — ${projectName}

1. Install the SDK (see \`AMBA.md\` for the exact command for your package manager).
2. Copy \`amba-example.tsx\` into your app and call it once at startup.
3. Verify the integration:

   \`\`\`bash
   amba status --detailed
   amba push test
   \`\`\`

4. Seed sample data (optional):

   \`\`\`bash
   amba seed --preset=starter
   \`\`\`

Docs: https://docs.amba.dev
`;
    await writeFile(readmeSnippetPath, readme, 'utf-8');
    written.push('AMBA_QUICKSTART.md');
  }

  return written;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();

  // Default to 'development' — `amba init` mints a personal dev project
  // unless the developer explicitly asks for prod. The flag flows
  // through to the create-project endpoint, which the provisioning
  // pipeline reads when allocating storage and resources.
  const environment: 'development' | 'production' = options.env ?? 'development';

  console.log();
  console.log(pc.bold('  amba init'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  // ─── Step 1: Authentication ──────────────────────────────────────────
  console.log(pc.bold('  Step 1/7 ') + pc.dim('Authenticate'));
  console.log();

  // Headless path first — `--token <pat>` or `AMBA_PAT` env skips the
  // browser entirely. The global `preAction` hook in `index.ts` has
  // already wired the override into the api-client; we just acknowledge
  // it in the UI. The listProjects() call below validates the token.
  // We do NOT write a PAT into ~/.amba/credentials.json — PATs are a
  // different credential class and mixing them with refresh-tokenable
  // JWTs invites confusion on re-runs without the env / flag.
  const headlessSource = resolveTokenSource({
    flagToken: undefined, // commander has already injected it; preAction wrote bearerOverride
    envToken: process.env['AMBA_PAT'],
  });
  const headlessActive =
    headlessSource !== null || (process.argv.includes('--token') && process.argv.length > 2);

  let needsAuth = true;
  if (headlessActive) {
    console.log(pc.green('  ✓') + ' Headless auth — using PAT from --token / AMBA_PAT');
    console.log(pc.dim('    (browser flow skipped; no credentials written to disk)'));
    console.log();
    needsAuth = false;
  } else {
    try {
      const existing = await loadCredentials();
      if (!isTokenExpired(existing)) {
        console.log(pc.green('  ✓') + ' Already authenticated');
        console.log();
        needsAuth = false;
      }
    } catch {
      // Not authenticated yet
    }
  }

  if (needsAuth) {
    const creds = await browserAuthFlow();

    // ─── Step 2: Store credentials ───────────────────────────────────────
    console.log(pc.bold('  Step 2/7 ') + pc.dim('Store credentials'));
    await storeCredentials(creds);
    console.log(pc.green('  ✓') + ' Credentials saved to ~/.amba/credentials.json');
    console.log();
  } else {
    console.log(pc.bold('  Step 2/7 ') + pc.dim('Store credentials'));
    if (headlessActive) {
      console.log(pc.green('  ✓') + ' (skipped — PAT supplied)');
    } else {
      console.log(pc.green('  ✓') + ' Using existing credentials');
    }
    console.log();
  }

  // ─── Step 3: Select or create project ────────────────────────────────
  console.log(pc.bold('  Step 3/7 ') + pc.dim('Select project'));
  console.log();

  let projectId: string;
  let projectName: string;

  try {
    const projectsRes = await listProjects();
    const projects = projectsRes.data;

    if (projects.length > 0) {
      console.log('  Existing projects:');
      projects.forEach((p, i) => {
        console.log(pc.dim(`    ${i + 1}.`) + ` ${p.name} ` + pc.dim(`(${p.id})`));
      });
      console.log(pc.dim(`    ${projects.length + 1}.`) + ' Create new project');
      console.log();

      const choice = await prompt(`  Select project (1-${projects.length + 1}): `);
      const choiceNum = parseInt(choice, 10);

      if (choiceNum > 0 && choiceNum <= projects.length) {
        const selected = projects[choiceNum - 1];
        if (!selected) {
          throw new Error('Invalid selection');
        }
        projectId = selected.id;
        projectName = selected.name;
        console.log(pc.green('  ✓') + ` Selected: ${projectName}`);
      } else {
        const name = await prompt('  Project name: ');
        if (!name) {
          console.log(pc.red('  ✗') + ' Project name is required');
          process.exit(1);
        }
        const res = await createProject({ name, environment });
        projectId = res.data.id;
        projectName = name;
        console.log(pc.green('  ✓') + ` Created: ${projectName} ${pc.dim(`(${environment})`)}`);
      }
    } else {
      const name = await prompt('  Project name: ');
      if (!name) {
        console.log(pc.red('  ✗') + ' Project name is required');
        process.exit(1);
      }
      const res = await createProject({ name });
      projectId = res.data.id;
      projectName = name;
      console.log(pc.green('  ✓') + ` Created: ${projectName}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('authenticate')) {
      throw err;
    }
    // If API is unreachable during development, allow manual entry
    const name = await prompt('  Project name: ');
    if (!name) {
      console.log(pc.red('  ✗') + ' Project name is required');
      process.exit(1);
    }
    const res = await createProject({ name });
    projectId = res.data.id;
    projectName = name;
    console.log(pc.green('  ✓') + ` Created: ${projectName}`);
  }

  console.log();

  // ─── Step 4: Generate API keys ───────────────────────────────────────
  console.log(pc.bold('  Step 4/7 ') + pc.dim('Generate API keys'));

  const keyRes = await createApiKey(projectId, 'client', 'development');
  const apiKey = keyRes.data.key;
  console.log(pc.green('  ✓') + ' Development client key created');
  console.log(pc.dim(`    ${keyRes.data.key_prefix}...`));
  console.log();

  // ─── Step 5: Write .env.local ────────────────────────────────────────
  console.log(pc.bold('  Step 5/7 ') + pc.dim('Write environment file'));

  const envPath = join(cwd, '.env.local');
  const envLines = [
    '# Amba SDK Configuration',
    `AMBA_PROJECT_ID=${projectId}`,
    `AMBA_API_KEY=${apiKey}`,
    `AMBA_API_URL=https://api.amba.dev`,
    '',
  ];

  if (await fileExists(envPath)) {
    const existing = await readFile(envPath, 'utf-8');
    // Check if Amba vars already exist
    if (existing.includes('AMBA_PROJECT_ID')) {
      console.log(pc.yellow('  !') + ' .env.local already contains Amba config — updating');
      // Replace existing values
      let updated = existing;
      updated = updated.replace(/AMBA_PROJECT_ID=.*/, `AMBA_PROJECT_ID=${projectId}`);
      updated = updated.replace(/AMBA_API_KEY=.*/, `AMBA_API_KEY=${apiKey}`);
      updated = updated.replace(/AMBA_API_URL=.*/, `AMBA_API_URL=https://api.amba.dev`);
      await writeFile(envPath, updated, 'utf-8');
    } else {
      // Append to existing file
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      await writeFile(envPath, existing + separator + envLines.join('\n'), 'utf-8');
    }
  } else {
    await writeFile(envPath, envLines.join('\n'), 'utf-8');
  }

  console.log(pc.green('  ✓') + ' .env.local written');
  console.log();

  // ─── Step 6: Detect framework and suggest install ────────────────────
  console.log(pc.bold('  Step 6/7 ') + pc.dim('Detect framework'));

  const framework = await detectFramework(cwd);
  const sdkPkg = getSdkPackage(framework);

  if (framework !== 'unknown') {
    console.log(pc.green('  ✓') + ` Detected: ${pc.bold(framework)}`);
  } else {
    console.log(pc.yellow('  !') + ' Could not detect framework');
  }

  // Detect package manager
  let installCmd = `npm install ${sdkPkg}`;
  if (await fileExists(join(cwd, 'bun.lockb'))) {
    installCmd = `bun add ${sdkPkg}`;
  } else if (await fileExists(join(cwd, 'pnpm-lock.yaml'))) {
    installCmd = `pnpm add ${sdkPkg}`;
  } else if (await fileExists(join(cwd, 'yarn.lock'))) {
    installCmd = `yarn add ${sdkPkg}`;
  }

  console.log(pc.dim(`    Install SDK: ${installCmd}`));
  console.log();

  // ─── Step 7: Generate context files ──────────────────────────────────
  console.log(pc.bold('  Step 7/7 ') + pc.dim('Generate context files'));

  const generatedFiles = await generateContextFiles({
    projectId,
    projectName,
    apiKey,
    framework,
    cwd,
  });

  for (const file of generatedFiles) {
    console.log(pc.green('  ✓') + ` ${file}`);
  }

  // ─── Optional: example scaffold ──────────────────────────────────────
  if (options.withExample) {
    const exampleFiles = await writeExampleScaffold(cwd, framework, projectName);
    if (exampleFiles.length > 0) {
      for (const file of exampleFiles) {
        console.log(pc.green('  ✓') + ` ${file} ` + pc.dim('(example)'));
      }
    } else {
      console.log(pc.dim('  -') + ' example files already present — skipping');
    }
  }

  console.log();

  // ─── Quick start guide ───────────────────────────────────────────────
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();
  console.log(pc.bold(pc.green('  ✓ Project initialized!')));
  console.log();
  console.log('  Quick start:');
  console.log();
  console.log(pc.dim('    1.') + ` Install the SDK`);
  console.log(`       ${pc.cyan(installCmd)}`);
  console.log();
  console.log(pc.dim('    2.') + ` Add the provider to your app`);

  if (framework === 'expo') {
    console.log(pc.dim(`       See AMBA.md for Amba.init() setup`));
  } else if (framework === 'react-native') {
    console.log(pc.dim(`       See AMBA.md for client initialization`));
  } else {
    console.log(pc.dim(`       See AMBA.md for client initialization`));
  }

  console.log();
  console.log(pc.dim('    3.') + ` Test the integration`);
  console.log(`       ${pc.cyan('amba status')}`);
  console.log();
  console.log(pc.dim('    4.') + ` Send a test notification`);
  console.log(`       ${pc.cyan('amba push test')}`);
  console.log();
  console.log(`  Docs: ${pc.underline('https://docs.amba.dev')}`);
  console.log();
}
