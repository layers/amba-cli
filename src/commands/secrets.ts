/**
 * `amba secrets ...` — write per-function secrets through the platform
 * API. The CLI sends `{name, value, function}` to the admin endpoint;
 * the server stores the value, validates reserved binding names, and
 * propagates it to the deployed Worker's binding. Sync is eventual —
 * `amba secrets list` shows progress.
 */

import pc from 'picocolors';
import { getBindingReservationReason } from '../_internal/shared.js';
import { deleteSecretViaApi, listSecretsViaApi, setSecretViaApi } from '../api-client.js';
import { loadProjectConfig } from '../project-config.js';
import { resolveSecretValue } from './ai.js';

// ─── set ───────────────────────────────────────────────────────────────

export interface SecretsSetOptions {
  /** Function name the secret binds to. Required — there are no project-wide secrets. */
  function: string;
  /**
   * Environment selector. Currently informational: both `dev` and `prod`
   * write to the same secret namespace per project. Workarounds:
   *   - Per-env naming convention: `STRIPE_KEY_DEV` vs `STRIPE_KEY_PROD`.
   *   - Two separate amba projects, one per env.
   */
  env?: 'dev' | 'prod';
  /**
   * Read the secret value from stdin instead of the positional `value`
   * arg. Keeps the secret out of shell history. Mutually exclusive with
   * a non-empty `value`.
   */
  fromStdin?: boolean;
}

export async function secretsSetCommand(
  name: string,
  value: string | undefined,
  options: SecretsSetOptions,
): Promise<void> {
  validateSecretName(name);
  // Resolve the value: --from-stdin OR positional arg, but not both
  // (the resolver throws on partial / contradictory input).
  const resolvedValue = await resolveSecretValue({
    key: value,
    fromStdin: options.fromStdin,
  });
  const projectConfig = await loadProjectConfig();
  // --env is informational only — log a note so the operator who
  // supplied --env=prod knows the value didn't go to a different
  // namespace.
  if (options.env === 'prod') {
    console.log(
      pc.dim(
        '  Note: --env is informational; prod and dev share one secret namespace per project.',
      ),
    );
  }

  console.log();
  console.log(pc.bold(`  amba secrets set ${pc.cyan(name)}`));
  console.log(pc.dim(`  function=${options.function}  env=${options.env ?? 'dev'}`));
  console.log();

  // Single API call replaces the previous (GCP write + register sync row)
  // pair. The server does both atomically and starts the sync workflow.
  const res = await setSecretViaApi(projectConfig.projectId, {
    name,
    value: resolvedValue,
    function: options.function,
  });

  console.log(
    pc.green('  ✓') + ` Secret ${pc.cyan(name)} stored ${pc.dim(`v${res.data.version}`)}`,
  );
  console.log(
    pc.green('  ✓') + ` Workers Secret sync ${pc.dim(`(status=${res.data.sync_status})`)} queued`,
  );
  console.log();
  console.log(
    pc.dim(
      '  Workers Secret will be live within ~30s. Run `amba secrets list` to check sync status.',
    ),
  );
  console.log();
}

// ─── list ──────────────────────────────────────────────────────────────

export async function secretsListCommand(): Promise<void> {
  const projectConfig = await loadProjectConfig();
  const res = await listSecretsViaApi(projectConfig.projectId);

  console.log();
  if (res.data.length === 0) {
    console.log(pc.dim('  No secrets configured.'));
    console.log();
    return;
  }
  for (const row of res.data) {
    const status = renderStatus(row.sync_status);
    console.log(
      `  ${pc.bold(row.name)} ` +
        pc.dim(`(${row.function})`) +
        ` v${row.version}  ${status}` +
        (row.last_error ? pc.dim(`  — ${row.last_error}`) : ''),
    );
  }
  console.log();
}

// ─── unset ─────────────────────────────────────────────────────────────

export async function secretsUnsetCommand(
  name: string,
  options: { function: string },
): Promise<void> {
  validateSecretName(name);
  const projectConfig = await loadProjectConfig();
  // API-proxy DELETE: server destroys the GCP version + clears the
  // sync row. The dispatched script's already-bound Workers Secret
  // remains until next deploy (intentional — see comment below).
  await deleteSecretViaApi(projectConfig.projectId, name, { function: options.function });
  console.log(pc.green('  ✓') + ` Removed from GCP Secret Manager.`);
  console.log(
    pc.dim(
      '  Workers Secret on the dispatched script remains until the next deploy — redeploy to clear.',
    ),
  );
  // Note: we deliberately don't try to also delete the Workers Secret here
  // — if we did it here AND on next deploy the script would be missing
  // the binding mid-flight. The "redeploy to clear" flow keeps the script
  // in a consistent state until the customer is ready.
}

// ─── helpers ───────────────────────────────────────────────────────────

function validateSecretName(name: string): void {
  // Client-side fast-fail mirrors the server's reservation check so the
  // dev loop stays snappy. Customer code MUST NOT shadow reserved
  // platform bindings (`AMBA_*`, `EDGE_*`, `STORAGE`, `HYPERDRIVE`,
  // `EDGE_DB_PROXY`).
  const reason = getBindingReservationReason(name);
  if (reason !== null) {
    throw new Error(`Secret name '${name}' rejected: ${reason}`);
  }
}

function renderStatus(status: string): string {
  switch (status) {
    case 'synced':
      return pc.green('synced');
    case 'syncing':
      return pc.cyan('syncing');
    case 'sync_failed_retrying':
      return pc.yellow('retrying');
    case 'pending':
    default:
      return pc.dim(status);
  }
}
