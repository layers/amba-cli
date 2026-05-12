/**
 * `amba ai providers ...` — register / list / remove AI provider API keys.
 *
 * Wire path: CLI → platform admin API. Plaintext is stored canonically
 * server-side; the CLI never echoes plaintext back. The API returns a
 * `api_key_preview` (first-6 + last-4) for confirmation.
 */

import pc from 'picocolors';
import {
  deleteAiProvider,
  listAiProviders,
  registerAiProvider,
  type AiProviderName,
} from '../api-client.js';
import { loadProjectConfig } from '../project-config.js';

const VALID_PROVIDERS: ReadonlySet<AiProviderName> = new Set(['anthropic', 'openai']);

function assertValidProvider(name: string): asserts name is AiProviderName {
  if (!VALID_PROVIDERS.has(name as AiProviderName)) {
    throw new Error(
      `Unknown AI provider '${name}'. Supported: ${[...VALID_PROVIDERS].join(', ')}.`,
    );
  }
}

// ─── add ───────────────────────────────────────────────────────────────

export interface AiProvidersAddOptions {
  /** API key plaintext. Mutually exclusive with `--from-stdin`. */
  key?: string;
  /**
   * When set, read the key from stdin instead of `--key`. Same shape as
   * `amba secrets set --from-stdin` for keep-out-of-shell-history flows.
   */
  fromStdin?: boolean;
}

export async function aiProvidersAddCommand(
  provider: string,
  options: AiProvidersAddOptions,
): Promise<void> {
  assertValidProvider(provider);

  // Resolve the key value: --key wins when both supplied (with a warning),
  // --from-stdin reads to EOF, else hard-fail with an actionable error.
  const apiKey = await resolveSecretValue(options);
  if (apiKey.length < 10) {
    throw new Error('AI provider api_key must be at least 10 characters.');
  }

  const projectConfig = await loadProjectConfig();
  console.log();
  console.log(pc.bold(`  amba ai providers add ${pc.cyan(provider)}`));
  console.log();

  const res = await registerAiProvider(projectConfig.projectId, {
    name: provider,
    api_key: apiKey,
  });
  console.log(pc.green('  ✓') + ` Registered ${provider}`);
  if (res.data.api_key_preview) {
    console.log(pc.dim(`    key preview: ${res.data.api_key_preview}`));
  }
  console.log(pc.dim(`    secret_name: ${res.data.api_key_secret_name ?? '(unset)'}`));
  console.log();
}

// ─── list ──────────────────────────────────────────────────────────────

export async function aiProvidersListCommand(): Promise<void> {
  const projectConfig = await loadProjectConfig();
  const res = await listAiProviders(projectConfig.projectId);
  console.log();
  if (res.data.length === 0) {
    console.log(pc.dim('  No AI providers registered.'));
    console.log(
      pc.dim('  Add one with: amba ai providers add anthropic --key sk-ant-...  (or --from-stdin)'),
    );
    console.log();
    return;
  }
  for (const p of res.data) {
    console.log(
      `  ${pc.bold(p.name)}  ` +
        pc.dim(`secret=${p.api_key_secret_name ?? '(unset)'}`) +
        (p.updated_at ? pc.dim(`  updated=${p.updated_at}`) : ''),
    );
  }
  console.log();
}

// ─── delete ────────────────────────────────────────────────────────────

export async function aiProvidersDeleteCommand(provider: string): Promise<void> {
  assertValidProvider(provider);
  const projectConfig = await loadProjectConfig();
  const res = await deleteAiProvider(projectConfig.projectId, provider);
  if (res.data.deleted) {
    console.log(pc.green('  ✓') + ` Removed ${provider}`);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * Read a secret value from CLI options. Shared by `amba ai providers
 * add` and `amba secrets set` — either `--key`/`<value>` arg OR
 * `--from-stdin` for shell-history-safe input.
 *
 * Resolution order:
 *   1. `--from-stdin` → consume stdin to EOF, return trimmed value.
 *      Errors if stdin is a TTY (would hang waiting for input the
 *      caller can't see they need to type).
 *   2. `--key` (or its inline equivalent) → return as-is.
 *   3. Neither → throw with the actionable error message.
 */
export async function resolveSecretValue(opts: {
  key?: string;
  fromStdin?: boolean;
}): Promise<string> {
  if (opts.fromStdin) {
    if (process.stdin.isTTY) {
      throw new Error(
        '--from-stdin was set but stdin is a TTY. Pipe the value in, e.g. `echo $KEY | amba ai providers add anthropic --from-stdin` or `amba ai providers add anthropic --from-stdin < ~/.anthropic-key`.',
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const value = Buffer.concat(chunks).toString('utf8').trim();
    if (value.length === 0) {
      throw new Error('--from-stdin: no input received on stdin.');
    }
    return value;
  }
  if (opts.key !== undefined && opts.key.length > 0) {
    return opts.key;
  }
  throw new Error(
    'Missing API key. Provide --key <value> OR --from-stdin (and pipe the value in).',
  );
}
