/**
 * `amba types generate [--watch]` — emits `.amba/types.d.ts`.
 *
 * One-shot is the default (CI-friendly). `--watch` is opt-in; the
 * engine emits deterministic output (no embedded timestamps unless we
 * pass `bannerTimestamp`), so the CLI compares strings to decide
 * whether to touch the file.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pc from 'picocolors';
// Import from the dedicated codegen subpath. Splitting out keeps the CLI's
// import graph slim — no client-runtime modules pulled in for a pure
// schema-fetch-and-emit operation. The subpath is wired in
// `packages/client/tsdown.config.ts` (multi-entry build) + the matching
// `./codegen` exports map.
import { generateCollectionTypes, type CodegenHttpClient } from '../_internal/codegen.js';
import { adminGet } from '../api-client.js';
import { loadProjectConfig } from '../project-config.js';

export interface TypesGenerateOptions {
  /** Output path. Default: `.amba/types.d.ts` under the current working directory. */
  out?: string;
  watch?: boolean;
}

export async function typesGenerateCommand(options: TypesGenerateOptions = {}): Promise<void> {
  const outPath = options.out ?? join(process.cwd(), '.amba', 'types.d.ts');

  if (options.watch) {
    console.log(pc.dim(`  Watching for collection schema changes — Ctrl+C to stop.`));
    let last = '';
    for (;;) {
      try {
        const next = await emit(outPath);
        if (next !== last) {
          console.log(pc.dim(`  ${new Date().toISOString()}`) + pc.green(' regenerated'));
          last = next;
        }
      } catch (err) {
        console.error(pc.red('  Error: ') + (err instanceof Error ? err.message : String(err)));
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    await emit(outPath);
    console.log(pc.green('  ✓') + ` Wrote ${outPath}`);
  }
}

async function emit(outPath: string): Promise<string> {
  const projectConfig = await loadProjectConfig();
  const http = makeCodegenHttpClient();
  const result = await generateCollectionTypes({
    http,
    projectId: projectConfig.projectId,
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, result.declarationsTs, 'utf-8');
  return result.declarationsTs;
}

/**
 * Adapt the CLI's authenticated admin-API helper to the engine's
 * minimal `CodegenHttpClient` shape. The engine emits paths starting
 * with `/admin/projects/...`; our `adminGet` already prefixes
 * `/admin`, so we strip the engine's `/admin` prefix before passing
 * through.
 */
function makeCodegenHttpClient(): CodegenHttpClient {
  return {
    async get<T>(path: string): Promise<{ data: T }> {
      const stripped = path.startsWith('/admin') ? path.slice('/admin'.length) : path;
      return adminGet<T>(stripped);
    },
  };
}
