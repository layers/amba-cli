import { createInterface } from 'node:readline';
import pc from 'picocolors';
import {
  listProjects,
  createProject,
  getProject,
  deleteProject,
  getProvisioningStatus,
  ApiClientError,
  type ProjectSummary,
} from '../api-client.js';

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function handleError(err: unknown): never {
  if (err instanceof ApiClientError) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      console.log(pc.red('  ✗') + ' Not authenticated — run `amba login` first.');
    } else {
      console.log(pc.red('  ✗') + ` ${err.message}`);
    }
  } else if (err instanceof Error) {
    console.log(pc.red('  ✗') + ` ${err.message}`);
  } else {
    console.log(pc.red('  ✗') + ' Unknown error');
  }
  console.log();
  process.exit(1);
}

function shortDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export async function projectsListCommand(): Promise<void> {
  console.log();
  console.log(pc.bold('  amba projects list'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  try {
    const res = await listProjects();
    const projects = res.data;

    if (projects.length === 0) {
      console.log(pc.dim('  No projects.'));
      console.log(pc.dim('  Create one with ') + pc.cyan('amba projects create --name <name>'));
      console.log();
      return;
    }

    const rows: Array<[string, string, string, string, string]> = projects.map(
      (p: ProjectSummary) => [
        p.id,
        p.name,
        p.environment ?? '—',
        p.status ?? 'active',
        shortDate(p.created_at),
      ],
    );

    const headers: [string, string, string, string, string] = [
      'Id',
      'Name',
      'Env',
      'Status',
      'Created',
    ];
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
    );

    const pad = (cells: [string, string, string, string, string]): string =>
      cells.map((cell, i) => String(cell).padEnd((widths[i] ?? 0) + 2)).join('');

    console.log('  ' + pc.bold(pad(headers)));
    console.log('  ' + pc.dim('─'.repeat(widths.reduce((a, b) => a + b + 2, 0))));
    for (const row of rows) {
      console.log('  ' + pad(row));
    }

    console.log();
    console.log(pc.dim(`  ${projects.length} project${projects.length === 1 ? '' : 's'}`));
    console.log();
  } catch (err) {
    handleError(err);
  }
}

export async function projectsCreateCommand(input: {
  name: string;
  env?: string;
  bundleId?: string;
  platform?: string;
}): Promise<void> {
  console.log();
  console.log(pc.bold('  amba projects create'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  if (!input.name) {
    console.log(pc.red('  ✗') + ' --name is required');
    console.log();
    process.exit(1);
  }

  // `--env=development` flags the row as a personal dev project
  // (different billing class, different MAU caps). Anything else falls
  // through as production. Validate up front so a typo on the env name
  // doesn't silently provision a prod project.
  let environment: 'development' | 'production' | undefined;
  if (input.env) {
    if (input.env === 'development' || input.env === 'dev') environment = 'development';
    else if (input.env === 'production' || input.env === 'prod') environment = 'production';
    else {
      console.log(
        pc.red('  ✗') + ` --env must be 'development' or 'production' (got '${input.env}').`,
      );
      console.log();
      process.exit(1);
    }
  }

  try {
    console.log(pc.dim('  Provisioning project...'));
    const res = await createProject({
      name: input.name,
      bundle_id: input.bundleId,
      platform: input.platform,
      environment,
    });

    const id = res.data.id;
    console.log(pc.green('  ✓') + ` Created: ${pc.bold(res.data.name)} ${pc.dim(`(${id})`)}`);

    // Poll provisioning status briefly so users see progress.
    console.log();
    console.log(pc.dim('  Checking provisioning status...'));
    try {
      const status = await getProvisioningStatus(id);
      const s = status.data;
      console.log(pc.dim(`    Status: ${s.status}`));
      if (s.errorMessage) {
        console.log(pc.yellow('    !') + ` ${s.errorMessage}`);
      }
    } catch {
      // Non-fatal — provisioning runs asynchronously.
      console.log(pc.dim('    (Provisioning runs asynchronously.)'));
    }

    if (environment) {
      console.log(pc.dim(`    Environment: ${environment}`));
    }

    console.log();
    console.log(pc.dim('  Next: ') + pc.cyan(`amba projects show ${id}`));
    console.log();
  } catch (err) {
    handleError(err);
  }
}

export async function projectsShowCommand(projectId: string): Promise<void> {
  console.log();
  console.log(pc.bold(`  amba projects show ${projectId}`));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  try {
    const res = await getProject(projectId);
    console.log(JSON.stringify(res.data, null, 2));
    console.log();
  } catch (err) {
    if (err instanceof ApiClientError && err.statusCode === 404) {
      console.log(pc.red('  ✗') + ` Project not found: ${projectId}`);
      console.log();
      process.exit(1);
    }
    handleError(err);
  }
}

export async function projectsDeleteCommand(
  projectId: string,
  opts: { yes?: boolean } = {},
): Promise<void> {
  console.log();
  console.log(pc.bold(`  amba projects delete ${projectId}`));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  if (!opts.yes) {
    const confirmed = await confirm(
      pc.yellow(`  Delete project ${projectId}? This is irreversible. (y/N) `),
    );
    if (!confirmed) {
      console.log(pc.dim('  Aborted.'));
      console.log();
      return;
    }
  }

  try {
    await deleteProject(projectId);
    console.log(pc.green('  ✓') + ` Deleted ${projectId}`);
    console.log();
  } catch (err) {
    if (err instanceof ApiClientError && err.statusCode === 404) {
      console.log(pc.red('  ✗') + ` Project not found: ${projectId}`);
      console.log();
      process.exit(1);
    }
    handleError(err);
  }
}
