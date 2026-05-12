import pc from 'picocolors';
import { reprovisionProject, getProvisioningStatus, ApiClientError } from '../api-client.js';
import { requireProjectId } from '../env.js';

export interface DbMigrateOptions {
  project?: string;
}

export async function dbMigrateCommand(opts: DbMigrateOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const projectId = await requireProjectId(cwd, opts.project);

  console.log();
  console.log(pc.bold('  amba db migrate'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();
  console.log(pc.dim(`  Project: ${projectId}`));
  console.log();
  console.log(pc.dim('  Running tenant migrations...'));
  console.log();

  try {
    const res = await reprovisionProject(projectId);
    const workflowId = res.data.workflowId;
    console.log(pc.green('  ✓') + ' Reprovision workflow started');
    if (workflowId) {
      console.log(pc.dim(`    workflowId: ${workflowId}`));
    }
    console.log();

    // Quick status check so the user can see current state.
    try {
      const status = await getProvisioningStatus(projectId);
      console.log(pc.dim(`  Status: ${status.data.status}`));
      if (status.data.errorMessage) {
        console.log(pc.yellow('  !') + ` ${status.data.errorMessage}`);
      }
    } catch {
      // Non-fatal — status is best-effort.
    }
    console.log();
    console.log(pc.dim('  Check again with: ') + pc.cyan(`amba projects show ${projectId}`));
    console.log();
  } catch (err) {
    if (err instanceof ApiClientError) {
      if (err.statusCode === 404) {
        console.log(pc.red('  ✗') + ` Project not found: ${projectId}`);
      } else if (err.statusCode === 409) {
        console.log(
          pc.yellow('  !') +
            ' Reprovision already in progress (or project is archived). ' +
            pc.dim('Nothing to do.'),
        );
        console.log();
        return;
      } else {
        console.log(pc.red('  ✗') + ` ${err.message}`);
      }
    } else if (err instanceof Error) {
      console.log(pc.red('  ✗') + ` ${err.message}`);
    }
    console.log();
    process.exit(1);
  }
}
