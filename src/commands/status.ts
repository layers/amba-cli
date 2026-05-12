import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';
import { loadCredentials, isTokenExpired } from '../auth.js';
import {
  getProject,
  validateApiKey,
  listIntegrations,
  listUsers,
  listSegments,
  getEventsCount,
  ApiClientError,
  type IntegrationSummary,
} from '../api-client.js';

export interface StatusOptions {
  detailed?: boolean;
}

interface EnvConfig {
  projectId: string | undefined;
  apiKey: string | undefined;
  apiUrl: string | undefined;
}

async function readEnvFile(cwd: string): Promise<EnvConfig> {
  const config: EnvConfig = {
    projectId: undefined,
    apiKey: undefined,
    apiUrl: undefined,
  };

  for (const filename of ['.env.local', '.env']) {
    try {
      const raw = await readFile(join(cwd, filename), 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();

        if (key === 'AMBA_PROJECT_ID') config.projectId = value;
        if (key === 'AMBA_API_KEY') config.apiKey = value;
        if (key === 'AMBA_API_URL') config.apiUrl = value;
      }
      break; // Use first file found
    } catch {
      continue;
    }
  }

  return config;
}

export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  const cwd = process.cwd();

  console.log();
  console.log(pc.bold('  amba status'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  // ─── Check CLI auth ────────────────────────────────────────────────
  console.log(pc.bold('  Authentication'));
  try {
    const creds = await loadCredentials();
    if (isTokenExpired(creds)) {
      console.log(pc.yellow('  ! Session expired') + pc.dim(' — run `amba login`'));
    } else {
      console.log(pc.green('  ✓ Logged in'));
    }
  } catch {
    console.log(pc.red('  ✗ Not authenticated') + pc.dim(' — run `amba login`'));
  }
  console.log();

  // ─── Check .env.local ──────────────────────────────────────────────
  console.log(pc.bold('  Local Configuration'));
  const env = await readEnvFile(cwd);

  if (!env.projectId && !env.apiKey) {
    console.log(pc.red('  ✗ No Amba config found') + pc.dim(' — run `amba init`'));
    console.log();
    return;
  }

  if (env.projectId) {
    console.log(pc.green('  ✓') + ` Project ID: ${pc.dim(env.projectId)}`);
  } else {
    console.log(pc.red('  ✗') + ' AMBA_PROJECT_ID not set');
  }

  if (env.apiKey) {
    // Show only the prefix for security
    const prefix = env.apiKey.length > 16 ? env.apiKey.slice(0, 16) + '...' : env.apiKey;
    console.log(pc.green('  ✓') + ` API Key:    ${pc.dim(prefix)}`);
  } else {
    console.log(pc.red('  ✗') + ' AMBA_API_KEY not set');
  }

  if (env.apiUrl) {
    console.log(pc.green('  ✓') + ` API URL:    ${pc.dim(env.apiUrl)}`);
  }

  console.log();

  // ─── Validate API key ──────────────────────────────────────────────
  if (env.apiKey) {
    console.log(pc.bold('  API Key Validation'));
    try {
      const result = await validateApiKey(env.apiKey);
      if (result.valid) {
        console.log(pc.green('  ✓') + ' API key is valid');
        console.log(pc.dim(`    Environment: ${result.environment}`));
      } else {
        console.log(pc.red('  ✗') + ` API key is invalid: ${result.error}`);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        console.log(pc.red('  ✗') + ` Validation failed: ${err.message}`);
      } else {
        console.log(pc.yellow('  !') + ' Could not reach API to validate key');
      }
    }
    console.log();
  }

  // ─── Project details ───────────────────────────────────────────────
  if (env.projectId) {
    console.log(pc.bold('  Project Details'));
    try {
      const project = await getProject(env.projectId);
      const p = project.data;
      console.log(`    Name:        ${p.name}`);
      console.log(`    Platform:    ${p.platform}`);
      console.log(`    Environment: ${p.environment}`);
      if (p.bundle_id) {
        console.log(`    Bundle ID:   ${p.bundle_id}`);
      }
      console.log(`    Created:     ${pc.dim(p.created_at)}`);
    } catch (err) {
      if (err instanceof ApiClientError && err.statusCode === 404) {
        console.log(pc.red('  ✗') + ' Project not found');
      } else if (err instanceof Error && err.message.includes('authenticate')) {
        console.log(pc.yellow('  !') + ' Login required to fetch project details');
      } else {
        console.log(pc.yellow('  !') + ' Could not fetch project details');
      }
    }
    console.log();
  }

  // ─── Context files ─────────────────────────────────────────────────
  console.log(pc.bold('  Context Files'));

  const contextFiles = ['AMBA.md', '.cursor/rules/amba.mdc'];
  for (const file of contextFiles) {
    try {
      await readFile(join(cwd, file), 'utf-8');
      console.log(pc.green('  ✓') + ` ${file}`);
    } catch {
      console.log(pc.dim('  -') + ` ${file} ` + pc.dim('(not generated — run `amba init`)'));
    }
  }

  console.log();

  // ─── Detailed section (behind --detailed) ──────────────────────────
  if (opts.detailed && env.projectId) {
    const projectId = env.projectId;

    console.log(pc.bold('  Integrations'));
    try {
      const res = await listIntegrations(projectId);
      const integrations = res.data;
      const expected = ['apns', 'fcm', 'revenuecat', 'superwall'] as const;
      const byProvider = new Map<string, IntegrationSummary>();
      for (const integ of integrations) {
        byProvider.set(String(integ.provider).toLowerCase(), integ);
      }
      for (const provider of expected) {
        const integ = byProvider.get(provider);
        if (!integ) {
          console.log(pc.dim('  -') + ` ${provider.toUpperCase()} ` + pc.dim('(not configured)'));
          continue;
        }
        const enabled = integ.enabled !== false && integ.status !== 'disabled';
        const icon = enabled ? pc.green('  ✓') : pc.yellow('  !');
        const label = provider.toUpperCase();
        const statusLabel = integ.status ?? (enabled ? 'active' : 'inactive');
        console.log(`${icon} ${label} ` + pc.dim(`(${statusLabel})`));
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        console.log(pc.yellow('  !') + ` Could not load integrations: ${err.message}`);
      } else {
        console.log(pc.yellow('  !') + ' Could not load integrations');
      }
    }
    console.log();

    console.log(pc.bold('  Metrics (last 24h)'));
    try {
      const users = await listUsers(projectId, { limit: 1 });
      const userCount = typeof users.total === 'number' ? users.total : users.data.length;
      console.log(pc.dim('    Users:    ') + String(userCount));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.log(pc.yellow('    Users:    ') + pc.dim(`(unavailable — ${msg})`));
    }

    try {
      const segs = await listSegments(projectId);
      const activeCount = segs.data.filter((s) => s.is_active !== false).length;
      console.log(pc.dim('    Segments: ') + `${activeCount} active / ${segs.data.length} total`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.log(pc.yellow('    Segments: ') + pc.dim(`(unavailable — ${msg})`));
    }

    // Event counts come from /events/count. The endpoint is recent — older
    // deployments may 404. Surface "events: unavailable" rather than crash
    // (the only sanctioned silent fallback in this command).
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let eventTotal: number | null = null;
    try {
      const totalRes = await getEventsCount(projectId, { since: since24h });
      eventTotal = totalRes.data.total;
      console.log(pc.dim('    Events:   ') + String(eventTotal));
    } catch (err) {
      if (err instanceof ApiClientError && err.statusCode === 404) {
        console.log(pc.dim('    Events:   ') + pc.dim('(unavailable — endpoint not deployed)'));
      } else {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.log(pc.yellow('    Events:   ') + pc.dim(`(unavailable — ${msg})`));
      }
    }

    if (eventTotal !== null && eventTotal > 0) {
      try {
        const grouped = await getEventsCount(projectId, {
          since: since24h,
          groupBy: 'event_name',
        });
        const top = (grouped.data.buckets ?? []).slice(0, 5);
        if (top.length > 0) {
          console.log(pc.dim('    Top events (24h):'));
          const widest = top.reduce((m, b) => Math.max(m, b.key.length), 0);
          for (const b of top) {
            console.log(pc.dim('      ') + b.key.padEnd(widest) + '  ' + pc.dim(String(b.count)));
          }
        }
      } catch (err) {
        if (err instanceof ApiClientError && err.statusCode === 404) {
          // Already noted above; skip silently.
        } else {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.log(pc.yellow('    Top events: ') + pc.dim(`(unavailable — ${msg})`));
        }
      }
    }

    console.log();
  } else if (opts.detailed && !env.projectId) {
    console.log(pc.yellow('  !') + ' --detailed requires AMBA_PROJECT_ID in .env.local');
    console.log();
  }
}
