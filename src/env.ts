import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';

/**
 * Read `AMBA_PROJECT_ID` from `.env.local` / `.env` in the given directory.
 * Returns null if not found.
 */
export async function getProjectIdFromEnv(cwd: string): Promise<string | null> {
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

/**
 * Resolve a project id in priority order:
 *   1. Explicit arg (e.g. `--project <id>`)
 *   2. `.env.local` / `.env` in cwd
 *
 * Prints a helpful error message and exits 1 if no id is found.
 */
export async function requireProjectId(cwd: string, explicit?: string | null): Promise<string> {
  if (explicit) return explicit;
  const fromEnv = await getProjectIdFromEnv(cwd);
  if (fromEnv) return fromEnv;
  console.log();
  console.log(pc.red('  ✗') + ' No project id');
  console.log(
    pc.dim('    Pass ') +
      pc.cyan('--project <id>') +
      pc.dim(' or run ') +
      pc.cyan('amba init') +
      pc.dim(' in this directory.'),
  );
  console.log();
  process.exit(1);
}
