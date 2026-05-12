/**
 * Local project config loader.
 *
 * `amba init` writes `.env.local` with `AMBA_PROJECT_ID` + `AMBA_API_KEY`.
 * Subsequent commands resolve the active project by reading `.env.local`
 * (or the OS env if exported); fail with a clear "run amba init first"
 * error if neither is set.
 *
 * Kept tiny on purpose — the CLI's full config story (per-environment
 * dev/prod selection) is a v2 follow-up; v1 just needs project id.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';

export interface ProjectConfig {
  projectId: string;
  apiUrl: string;
}

const ENV_LOCAL_FILES = ['.env.local', '.env'];

export async function loadProjectConfig(cwd: string = process.cwd()): Promise<ProjectConfig> {
  // Process env wins (Doppler-injected, CI, explicit override).
  let projectId = process.env['AMBA_PROJECT_ID'];
  let apiUrl = process.env['AMBA_API_URL'];

  if (!projectId || !apiUrl) {
    for (const filename of ENV_LOCAL_FILES) {
      const path = join(cwd, filename);
      const content = await readFile(path, 'utf-8').catch(() => null);
      if (!content) continue;
      const parsed = parseEnv(content);
      if (!projectId) projectId = parsed['AMBA_PROJECT_ID'];
      if (!apiUrl) apiUrl = parsed['AMBA_API_URL'];
      if (projectId && apiUrl) break;
    }
  }

  if (!projectId) {
    throw new Error(
      `AMBA_PROJECT_ID not found. Run ${pc.cyan('amba init')} or set it in .env.local.`,
    );
  }
  return {
    projectId,
    apiUrl: apiUrl ?? 'https://api.amba.dev',
  };
}

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
