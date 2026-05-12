/**
 * `amba functions ...` commands.
 *
 * `deploy` bundles the entry file with esbuild (externalizing the runtime
 * stdlib + size-checking before upload), then POSTs the bundle to the
 * platform API. The server resolves bindings, uploads the script, and
 * records the deployment in a single round-trip. The other subcommands
 * are thin shells over the admin API helpers in `api-client.ts`.
 */

import { basename } from 'node:path';
import pc from 'picocolors';
import {
  deleteFunctionViaApi,
  deleteQueueBinding,
  deployFunctionViaApi,
  listFunctionDeployments,
  listQueueBindings,
  scheduleFunction,
  upsertQueueBinding,
} from '../api-client.js';
import { bundleFunction, printBundleReport } from '../bundle.js';
import { loadProjectConfig } from '../project-config.js';
import { validateRateLimitConfig, type RateLimitConfig, type RateLimitKeyKind } from '../_internal/shared.js';

// ─── deploy ────────────────────────────────────────────────────────────

export interface DeployOptions {
  /** Override the function name. Default: filename without extension. */
  name?: string;
  /** Print bundle report but skip the CF API + DB write. Useful for size triage. */
  dryRun?: boolean;
  /**
   * Optional declarative rate-limit config. All three sub-fields must be
   * provided together; any one missing is a deploy error. Validated via
   * `validateRateLimitConfig` before the API roundtrip so typos fail
   * fast on the developer's machine. Persisted on the deployment row;
   * the edge router enforces it pre-dispatch.
   */
  rateLimitWindow?: string;
  rateLimitMax?: number;
  rateLimitKey?: string;
}

export async function functionsDeployCommand(
  entryPoint: string,
  options: DeployOptions = {},
): Promise<void> {
  const projectConfig = await loadProjectConfig();
  const projectId = projectConfig.projectId;

  const functionName = options.name ?? basename(entryPoint).replace(/\.[^.]+$/, '');
  validateFunctionName(functionName);

  // Resolve + validate the optional rate-limit config from CLI flags.
  // All three sub-fields together OR all three absent. Any partial set
  // is a deploy error — a customer who typed `--rate-limit-max 20`
  // expecting a default `window` would silently get NO rate limit
  // instead, which is the wrong default for a security-adjacent flag.
  const rateLimit = parseRateLimitFlags(options);

  console.log();
  console.log(pc.bold(`  amba functions deploy ${pc.cyan(functionName)}`));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  // 1. Bundle locally — same `bundleFunction` path, no change.
  console.log(pc.dim('  Bundling…'));
  const bundle = await bundleFunction({ entryPoint });
  printBundleReport(bundle);

  if (options.dryRun) {
    console.log(pc.yellow('  ! Dry run — skipping API upload.'));
    return;
  }

  // 2. POST the bundle to the platform API. The server resolves
  //    runtime bindings, uploads the script, and records the deployment
  //    in one server-side call — customer never sees the underlying
  //    infrastructure.
  console.log(pc.dim('  Uploading…'));
  const result = await deployFunctionViaApi(projectId, {
    name: functionName,
    bundleCode: bundle.code,
    rate_limit: rateLimit,
  });

  console.log(
    pc.green('  ✓') +
      ` Deployed ${pc.cyan(functionName)} ${pc.dim(`v${result.data.version} (${result.data.cf_script_name})`)}`,
  );
  console.log(pc.green('  ✓') + ` URL: ${pc.underline(result.fn_url)}`);
  if (rateLimit) {
    console.log(
      pc.dim(
        `  Rate limit: ${rateLimit.max} per ${rateLimit.window} (key=${rateLimit.key}) — enforced pre-dispatch`,
      ),
    );
  }
  console.log();
}

// ─── list ──────────────────────────────────────────────────────────────

export async function functionsListCommand(): Promise<void> {
  const projectConfig = await loadProjectConfig();
  const res = await listFunctionDeployments(projectConfig.projectId, { activeOnly: true });
  console.log();
  if (res.data.length === 0) {
    console.log(pc.dim('  No functions deployed.'));
    console.log();
    return;
  }
  for (const d of res.data) {
    console.log(
      `  ${pc.bold(d.name)} ${pc.dim('v' + d.version)}  ` +
        pc.dim(`sha=${d.bundle_sha.slice(0, 12)}…  ${d.created_at}`),
    );
  }
  console.log();
}

// ─── delete ────────────────────────────────────────────────────────────

export async function functionsDeleteCommand(
  name: string,
  options: { confirm?: string } = {},
): Promise<void> {
  validateFunctionName(name);
  if (!options.confirm || options.confirm !== name) {
    throw new Error(
      `Delete is destructive. Pass --confirm ${name} to proceed. Customer Workers calling this function will start 404'ing immediately.`,
    );
  }
  const projectConfig = await loadProjectConfig();

  // Server-side cascade: removes the deployed script, then marks every
  // historical deployment row as disabled. Idempotent on already-deleted.
  const res = await deleteFunctionViaApi(projectConfig.projectId, name, { confirm: name });
  const cascade = res.data.cascade;
  console.log(pc.green('  ✓') + ` Deleted ${pc.bold(name)}.`);
  console.log(
    pc.dim(
      `    Cascade: cf_dispatch_script_deleted=${cascade.cf_dispatch_script_deleted ?? false}, function_deployments_marked_disabled=${cascade.function_deployments_marked_disabled ?? 0}`,
    ),
  );
}

// ─── schedule ──────────────────────────────────────────────────────────

export async function functionsScheduleCommand(
  name: string,
  cron: string,
  options: { tz?: string } = {},
): Promise<void> {
  const projectConfig = await loadProjectConfig();
  validateFunctionName(name);
  // Default to UTC if no timezone is supplied.
  const timezone = options.tz ?? 'UTC';
  const res = await scheduleFunction(projectConfig.projectId, {
    name,
    cron,
    timezone,
  });
  console.log();
  console.log(
    pc.green('  ✓') + ` Scheduled ${pc.bold(name)} — ${pc.cyan(cron)} ${pc.dim(`(${timezone})`)}`,
  );
  console.log(pc.dim(`    schedule_id: ${res.data.schedule_id}`));
  console.log();
}

// ─── dev ───────────────────────────────────────────────────────────────

/**
 * `amba functions dev` — not configured in this release. Use
 * `amba functions deploy <file>` to deploy via the platform API.
 */
export async function functionsDevCommand(_entryPoint: string): Promise<void> {
  console.error(
    pc.red('  Error: `amba functions dev` is not available in this release.'),
  );
  console.error(
    pc.dim(
      '    Use `amba functions deploy <file>` to deploy via the platform API.',
    ),
  );
  process.exit(1);
}

// ─── consume / consumers (queue bindings) ──────────────────────────────

/**
 * `amba functions consume <queue> <function>` — bind a function as the
 * consumer for a queue. Customers send to a queue with `ctx.queue.send`;
 * the genericQueueJobWorkflow looks up the binding and invokes the
 * bound function with the payload.
 *
 * Single binding per (project, queue). Re-running with a different
 * function-name overwrites — same upsert semantics as `amba secrets set`.
 */
export async function functionsConsumeCommand(
  queueName: string,
  functionName: string,
  options: { paused?: boolean } = {},
): Promise<void> {
  validateFunctionName(functionName); // also validates queue-name shape
  validateFunctionName(queueName);
  const projectConfig = await loadProjectConfig();
  const res = await upsertQueueBinding(projectConfig.projectId, {
    queue_name: queueName,
    function_name: functionName,
    status: options.paused ? 'paused' : 'active',
  });
  console.log();
  console.log(
    pc.green('  ✓') +
      ` Queue ${pc.cyan(queueName)} → function ${pc.cyan(functionName)} ${pc.dim(`(${res.data.status})`)}`,
  );
  console.log();
}

/**
 * `amba functions consumers list` / `amba functions consumers unbind`
 * sub-tree. Mirrors the `amba secrets list` shape so the CLI surface
 * stays consistent.
 */
export async function functionsConsumersListCommand(): Promise<void> {
  const projectConfig = await loadProjectConfig();
  const res = await listQueueBindings(projectConfig.projectId);
  console.log();
  if (res.data.length === 0) {
    console.log(pc.dim('  No queue bindings configured.'));
    console.log();
    return;
  }
  for (const b of res.data) {
    const status = b.status === 'active' ? pc.green('active') : pc.yellow('paused');
    console.log(`  ${pc.bold(b.queue_name)} → ${pc.cyan(b.function_name)}  ${status}`);
  }
  console.log();
}

export async function functionsConsumersUnbindCommand(queueName: string): Promise<void> {
  validateFunctionName(queueName);
  const projectConfig = await loadProjectConfig();
  await deleteQueueBinding(projectConfig.projectId, queueName);
  console.log(pc.green('  ✓') + ` Unbound queue ${pc.cyan(queueName)}.`);
}

// ─── helpers ───────────────────────────────────────────────────────────

function validateFunctionName(name: string): void {
  // Same shape as collection names per the plan — keeps customer mental
  // model consistent and lets us derive table names if we ever auto-bind
  // a function to a collection.
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      `Invalid function name '${name}'. Must match /^[a-z][a-z0-9_-]*$/ (lowercase ASCII, digits, underscore or hyphen; must start with a letter).`,
    );
  }
  if (name.length > 58) {
    throw new Error('Function name must be 58 characters or fewer.');
  }
}

/**
 * Resolve the optional rate-limit config from CLI flags. Returns the
 * validated config if all three sub-flags are set, `null` if all three
 * are absent, or throws if a partial set was supplied.
 *
 * The "all-or-nothing" rule is intentional — defaulting any sub-flag
 * is too easy to mis-set. A customer who types `--rate-limit-max 20`
 * expecting "use a default 60s window with ip key" would silently get
 * NO rate limit instead, which is the wrong default for a security-
 * adjacent flag. Forcing all three to be explicit means the failure
 * mode is "fail loud at deploy" not "silently no rate limit."
 */
function parseRateLimitFlags(options: DeployOptions): RateLimitConfig | null {
  const window = options.rateLimitWindow;
  const max = options.rateLimitMax;
  const key = options.rateLimitKey;

  // All three absent → no rate limit, normal deploy.
  if (window === undefined && max === undefined && key === undefined) {
    return null;
  }
  // Partial set → loud error. The error message names the missing
  // flags so the developer can fix in one shot.
  const missing: string[] = [];
  if (window === undefined) missing.push('--rate-limit-window');
  if (max === undefined) missing.push('--rate-limit-max');
  if (key === undefined) missing.push('--rate-limit-key');
  if (missing.length > 0) {
    throw new Error(
      `Rate-limit flags must be supplied together. Missing: ${missing.join(', ')}. ` +
        'Either provide all three or omit all three (no rate limit).',
    );
  }

  // Validate via the shared module — single source of truth across CLI,
  // API, and edge-router. Throws a descriptive error on invalid shape.
  const validated = validateRateLimitConfig({
    window,
    max,
    key: key as RateLimitKeyKind,
  });
  if ('error' in validated) {
    throw new Error(`Rate-limit config invalid: ${validated.error}`);
  }
  return validated;
}

/**
 * Test-only re-export of internal helpers. Not a public API — anything
 * here is unstable across patches.
 */
export const __testHelpers = {
  parseRateLimitFlags,
};
