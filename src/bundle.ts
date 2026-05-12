/**
 * Customer-function bundling for `amba functions deploy`.
 *
 * Uses esbuild (the Workers ecosystem bundler-of-record). The shared
 * runtime stdlib is marked `external` so customer bundles don't
 * re-include megabytes of `@anthropic-ai/sdk`, `postgres`, `zod`, etc.;
 * these resolve at dispatch time via platform-level bindings.
 *
 * Two checks gate the bundle before upload:
 *   1. Pre-upload size check against `BUNDLE_MAX_SIZE_BYTES` (8 MB
 *      default — the platform's 10 MB compressed cap minus 2 MB
 *      headroom) with a clear error pointing at the externalization
 *      config.
 *   2. Bundle-shape report — the CLI prints what's externalized vs
 *      bundled at deploy time so size issues are debuggable.
 */

import { build, type BuildOptions, type BuildResult } from 'esbuild';
import { stat } from 'node:fs/promises';
import pc from 'picocolors';

/**
 * Modules customer code MUST externalize. The runtime exposes these as
 * platform-level bindings; bundling them per-script wastes hundreds of
 * KB to MBs and quickly hits the script-size cap.
 */
export const RUNTIME_STDLIB_EXTERNALS: readonly string[] = [
  '@layers/amba-functions',
  '@layers/amba-api-middleware',
  '@anthropic-ai/sdk',
  'postgres',
  'zod',
];

/**
 * Default maximum bundle size — 8 MB compressed. CF's hard cap is 10 MB
 * compressed (paid plan); we reject at 8 MB to leave headroom for the
 * compression-ratio variance and for the dispatch-namespace metadata.
 */
export const BUNDLE_MAX_SIZE_BYTES = 8 * 1024 * 1024;

export class BundleSizeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `Function bundle is ${formatBytes(sizeBytes)} which exceeds the ${formatBytes(maxBytes)} cap. ` +
        `Externalize heavy dependencies via the runtime stdlib (see RUNTIME_STDLIB_EXTERNALS) ` +
        `or split your function into smaller pieces.`,
    );
    this.name = 'BundleSizeError';
  }
}

export interface BundleResult {
  /** The bundled JS source (UTF-8). */
  code: string;
  /** SHA-256 hex of the bundle (used for `function_deployments.bundle_sha`). */
  sha256: string;
  /** Compressed size in bytes (gzipped — what CF measures against the cap). */
  compressedSize: number;
  /** Uncompressed size in bytes — for human-friendly CLI output. */
  uncompressedSize: number;
  /** What esbuild externalized vs bundled in this build (CLI display). */
  externals: string[];
}

export interface BundleOptions {
  /** Path to the customer's entry file, e.g. `./functions/scan-letter.ts`. */
  entryPoint: string;
  /** Override the max bundle size. */
  maxSizeBytes?: number;
  /** Additional externals beyond `RUNTIME_STDLIB_EXTERNALS`. */
  extraExternals?: string[];
  /** Source map handling. Default: inline. */
  sourcemap?: BuildOptions['sourcemap'];
}

/**
 * Bundle a customer function file for upload to a Workers dispatch
 * namespace. Returns the bundled code + metadata; throws
 * `BundleSizeError` when the compressed size exceeds the cap so the CLI
 * can surface a clear error.
 */
export async function bundleFunction(options: BundleOptions): Promise<BundleResult> {
  const stats = await stat(options.entryPoint).catch(() => null);
  if (!stats?.isFile()) {
    throw new Error(`Entry point not found or not a file: ${options.entryPoint}`);
  }

  const externals = [...RUNTIME_STDLIB_EXTERNALS, ...(options.extraExternals ?? [])];

  const result: BuildResult = await build({
    entryPoints: [options.entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'browser', // Workers expose Web Platform globals.
    target: 'es2022',
    external: externals,
    minify: true,
    sourcemap: options.sourcemap ?? 'inline',
    write: false,
    // Workers don't have Node's fs / net / etc. — esbuild raises if the
    // customer accidentally imported one of these without externalizing.
    conditions: ['workerd', 'worker', 'browser', 'import'],
    metafile: true,
  });

  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error('esbuild produced no output');
  }

  const code = new TextDecoder().decode(output.contents);
  const uncompressedSize = output.contents.byteLength;

  // Compute compressed size. CF's cap is on the compressed bundle.
  const compressedSize = await gzipSizeOf(output.contents);

  const max = options.maxSizeBytes ?? BUNDLE_MAX_SIZE_BYTES;
  if (compressedSize > max) {
    throw new BundleSizeError(compressedSize, max);
  }

  // Hash the uncompressed code — `function_deployments.bundle_sha` is the
  // dedup key, and we want it to be deterministic regardless of the
  // compression pipeline (which CF may swap under us).
  const sha256 = await hashSha256Hex(output.contents);

  return {
    code,
    sha256,
    compressedSize,
    uncompressedSize,
    externals,
  };
}

/**
 * Print the bundle's externalization report to stdout. Intended to be
 * called from `amba functions deploy` after bundling so customers can
 * see what got externalized vs included at a glance.
 */
export function printBundleReport(bundle: BundleResult): void {
  console.log();
  console.log(pc.dim('  Bundle:'));
  console.log(
    pc.dim('    size: ') +
      `${formatBytes(bundle.compressedSize)} compressed ` +
      pc.dim(`(${formatBytes(bundle.uncompressedSize)} raw)`),
  );
  console.log(pc.dim('    sha:  ') + bundle.sha256.slice(0, 16) + pc.dim('…'));
  console.log(pc.dim('    externalized:'));
  for (const e of bundle.externals) {
    console.log(pc.dim('      • ') + e);
  }
  console.log();
}

// ─── Helpers ───────────────────────────────────────────────────────────

async function gzipSizeOf(bytes: Uint8Array): Promise<number> {
  // Node's zlib is the simplest gzip path here. Workers customers don't
  // run this code — only the CLI does, in Node.
  const { gzipSync } = await import('node:zlib');
  return gzipSync(bytes, { level: 9 }).byteLength;
}

async function hashSha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}
