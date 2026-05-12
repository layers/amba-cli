import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';
import { sendTestPush, ApiClientError } from '../api-client.js';

async function getProjectId(cwd: string): Promise<string | null> {
  for (const filename of ['.env.local', '.env']) {
    try {
      const raw = await readFile(join(cwd, filename), 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('AMBA_PROJECT_ID=')) {
          return trimmed.slice('AMBA_PROJECT_ID='.length).trim();
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function pushTestCommand(): Promise<void> {
  const cwd = process.cwd();

  console.log();
  console.log(pc.bold('  amba push test'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  const projectId = await getProjectId(cwd);
  if (!projectId) {
    console.log(pc.red('  ✗') + ' AMBA_PROJECT_ID not found in .env.local');
    console.log(pc.dim('    Run `amba init` to set up your project'));
    console.log();
    process.exit(1);
  }

  console.log(pc.dim('  Sending test push notification...'));
  console.log();

  try {
    const result = await sendTestPush(projectId, {
      title: 'Amba Test',
      body: 'If you see this, push notifications are working!',
      data: { source: 'cli-test' },
    });

    console.log(pc.green('  ✓') + ` ${result.data.message}`);
    console.log(pc.dim(`    Sent to ${result.data.sent} device(s)`));
    console.log();
  } catch (err) {
    if (err instanceof ApiClientError) {
      if (err.statusCode === 404) {
        console.log(pc.red('  ✗') + ' Project not found');
        console.log(pc.dim('    Check your AMBA_PROJECT_ID in .env.local'));
      } else if (err.statusCode === 422) {
        console.log(pc.yellow('  !') + ' No push tokens registered yet');
        console.log(pc.dim('    Install the SDK in your app and register a push token first'));
      } else {
        console.log(pc.red('  ✗') + ` Failed: ${err.message}`);
      }
    } else if (err instanceof Error) {
      console.log(pc.red('  ✗') + ` ${err.message}`);
    }
    console.log();
    process.exit(1);
  }
}
