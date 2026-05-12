/**
 * `amba sites ...` commands.
 *
 * Static-site hosting. The CLI orchestrates two halves on every deploy:
 *
 *   1. Register the site row in the control plane via the admin API so
 *      domains can attach with a stable `cert_status` for polling.
 *   2. Upload the pre-built static directory through the platform API,
 *      which proxies to the underlying CDN.
 *
 * This command does NOT build static files — accept a pre-built
 * directory (mirrors `wrangler pages deploy ./out` semantics). Dynamic
 * logic belongs in `amba functions deploy`, not in a site directory.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import pc from 'picocolors';

import {
  addSiteDomainViaApi,
  createSite,
  deleteSiteViaApi,
  deploySiteViaApi,
  describeSite,
  listSiteDomains,
  listSites,
  removeSiteDomainViaApi,
  rollbackSiteViaApi,
  updateSite,
  type SiteDomainRow,
} from '../api-client.js';
import { loadProjectConfig } from '../project-config.js';

// ─── Validation ────────────────────────────────────────────────────────

const SITE_NAME_RE = /^[a-z][a-z0-9_-]{0,49}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function validateSiteName(name: string): void {
  if (!SITE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid site name '${name}'. Must match /^[a-z][a-z0-9_-]{0,49}$/ (lowercase ASCII, digits, underscore or hyphen; ≤50 chars).`,
    );
  }
}

function validateHostname(host: string): void {
  if (!HOSTNAME_RE.test(host)) {
    throw new Error(
      `Invalid hostname '${host}'. Must be a DNS-shaped name (e.g. site.example.com).`,
    );
  }
}

// ─── Limits ────────────────────────────────────────────────────────────

/**
 * Per-deploy size cap. CF Pages enforces 25 MiB per file + 25k files; we
 * pre-flight at 100 MiB total so the developer sees an actionable error
 * before we spend their time on a multi-second upload. Above this, point
 * them at a Pages-only deployment outside amba.
 */
const MAX_DEPLOYMENT_BYTES = 100 * 1024 * 1024;
const MAX_DEPLOYMENT_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// ─── deploy ────────────────────────────────────────────────────────────

export interface SitesDeployOptions {
  /** Site name. Defaults to the leaf directory name. */
  name?: string;
  /** Skip CF upload; just print what would happen. */
  dryRun?: boolean;
}

export async function sitesDeployCommand(
  inputDir: string,
  options: SitesDeployOptions = {},
): Promise<void> {
  const projectConfig = await loadProjectConfig();
  const projectId = projectConfig.projectId;

  const siteName =
    options.name ??
    basename(inputDir)
      .replace(/[^a-z0-9_-]/gi, '-')
      .toLowerCase();
  validateSiteName(siteName);

  console.log();
  console.log(pc.bold(`  amba sites deploy ${pc.cyan(siteName)}`));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  // 1. Walk the input directory and collect files.
  console.log(pc.dim(`  Scanning ${inputDir}…`));
  const dirStat = await stat(inputDir).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error(`'${inputDir}' is not a directory. Pass a built static site folder.`);
  }

  const files = await collectFiles(inputDir);
  if (files.length === 0) {
    throw new Error(`No files found under ${inputDir}.`);
  }
  if (files.length > MAX_DEPLOYMENT_FILES) {
    throw new Error(
      `Too many files (${files.length} > ${MAX_DEPLOYMENT_FILES}). Pages-for-Platforms enforces a 20k-file cap.`,
    );
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_DEPLOYMENT_BYTES) {
    throw new Error(
      `Deployment too large (${formatBytes(totalBytes)} > ${formatBytes(MAX_DEPLOYMENT_BYTES)}). Trim assets or split into multiple sites.`,
    );
  }
  console.log(pc.dim(`    ${files.length} files, ${formatBytes(totalBytes)}`));

  if (options.dryRun) {
    console.log(pc.yellow('  ! Dry run — skipping CF Pages upload + control-plane write.'));
    console.log();
    return;
  }

  // 2. Ensure the site row exists in the control DB. Server-side
  //    `POST /sites/:name/deployments` 404s with SITE_NOT_FOUND if no
  //    row, so the registration is mandatory + idempotent on re-runs
  //    (409 from createSite means "row already exists" — recover via
  //    describeSite to keep the CLI deploy command idempotent).
  let cfPagesProjectName: string;
  try {
    const created = await createSite(projectId, { name: siteName });
    cfPagesProjectName = created.data.cf_pages_project_name;
    console.log(pc.green('  ✓') + ` Registered site (cf_pages_project=${cfPagesProjectName})`);
  } catch (err) {
    // Re-running deploy should be idempotent. The admin route returns
    // 409 on duplicate name; describe to recover the existing row.
    const existing = await describeSite(projectId, siteName);
    cfPagesProjectName = existing.data.cf_pages_project_name;
    console.log(pc.dim(`  Site already registered (cf_pages_project=${cfPagesProjectName})`));
  }

  // 3. Build the multipart payload + POST to the platform API. The
  //    server forwards to the CDN; customer never sees its credentials.
  console.log(pc.dim('  Uploading…'));
  const formData = await buildPagesDeploymentForm(files);
  const res = await deploySiteViaApi(projectId, siteName, formData);
  const dep = res.data;
  console.log(
    pc.green('  ✓') +
      ` Deployed ${dep.deployment_id.slice(0, 12)} ${pc.dim(`(branch=${dep.branch}, status=${dep.status})`)}`,
  );
  console.log(pc.green('  ✓') + ` URL: ${pc.underline(dep.url)}`);
  if (dep.preview_url && dep.preview_url !== dep.url) {
    console.log(pc.dim(`    preview (CF): ${dep.preview_url}`));
  }

  // 5. Print attached domains so the developer remembers what's live.
  const domains = await listSiteDomains(projectId, siteName);
  if (domains.data.length > 0) {
    console.log();
    console.log(pc.dim('  Domains:'));
    for (const d of domains.data) {
      console.log(`    ${pc.bold(d.hostname)}  ${formatCertStatus(d.cert_status)}`);
    }
  }
  console.log();
}

// ─── list ──────────────────────────────────────────────────────────────

export async function sitesListCommand(): Promise<void> {
  const projectConfig = await loadProjectConfig();
  const res = await listSites(projectConfig.projectId);
  console.log();
  if (res.data.length === 0) {
    console.log(pc.dim('  No sites deployed.'));
    console.log();
    return;
  }
  for (const s of res.data) {
    const status = s.status === 'active' ? pc.green('active') : pc.yellow(s.status);
    console.log(
      `  ${pc.bold(s.name)}  ${status}  ${pc.dim(`pages=${s.cf_pages_project_name}  ${s.created_at}`)}`,
    );
  }
  console.log();
}

// ─── logs (Pages deployments) ──────────────────────────────────────────

/**
 * `amba sites logs <name>` — not yet available via the public API. Use
 * the developer console for deployment history, or `amba sites describe`
 * for the current cert / domain state.
 */
export async function sitesLogsCommand(name: string): Promise<void> {
  validateSiteName(name);
  console.log();
  console.log(
    pc.yellow('  ! `amba sites logs` is not available in this release.'),
  );
  console.log();
  console.log(pc.dim('  Alternatives:'));
  console.log(
    pc.dim('    amba sites describe <name>   (current state + domains/certs)'),
  );
  console.log(
    pc.dim('    https://app.amba.dev          (full deployment history UI)'),
  );
  console.log();
}

// ─── rollback ──────────────────────────────────────────────────────────

export async function sitesRollbackCommand(
  name: string,
  options: { to?: string } = {},
): Promise<void> {
  validateSiteName(name);
  if (!options.to) {
    // Deployment listing isn't exposed through the public API yet;
    // customers must pass an explicit `--to <deployment_id>`.
    throw new Error(
      'sites rollback requires --to <deployment_id>. Find the target deployment in `amba sites describe` or the developer console.',
    );
  }
  const projectConfig = await loadProjectConfig();

  const res = await rollbackSiteViaApi(projectConfig.projectId, name, options.to);
  const dep = res.data;
  console.log(
    pc.green('  ✓') +
      ` Rolled back to ${options.to.slice(0, 12)}; new deployment ${pc.cyan(dep.deployment_id.slice(0, 12))} ${pc.dim(`(status=${dep.status})`)} is now live.`,
  );
  console.log(pc.green('  ✓') + ` URL: ${pc.underline(dep.url)}`);
}

// ─── domain add / list / remove ────────────────────────────────────────

export interface SitesDomainAddOptions {
  /** Required — which site this domain points at. */
  site: string;
  /** Reserved for backwards compatibility; ignored. */
  zoneId?: string;
  /** Skip the cert poll loop. Caller will check status later. */
  noWait?: boolean;
  /** Max seconds to wait for cert_status='active' before bailing. Default 600. */
  timeout?: number;
}

export async function sitesDomainAddCommand(
  hostname: string,
  options: SitesDomainAddOptions,
): Promise<void> {
  validateSiteName(options.site);
  validateHostname(hostname);
  const projectConfig = await loadProjectConfig();
  const projectId = projectConfig.projectId;

  console.log();
  console.log(pc.bold(`  amba sites domain add ${pc.cyan(hostname)}`));
  console.log(pc.dim(`  → site ${pc.cyan(options.site)}`));
  console.log();

  // Server-side proxy registers the custom hostname and returns the
  // dns_target the customer should CNAME at.
  const res = await addSiteDomainViaApi(projectId, options.site, hostname);
  console.log(pc.green('  ✓') + ` Custom Hostname registered (cf_id=${res.data.cf_hostname_id})`);

  // Print the CNAME the customer needs to add at their DNS provider.
  console.log();
  console.log(pc.dim('  Point your DNS at:'));
  console.log(`    ${pc.bold('CNAME')} ${hostname}  →  ${pc.cyan(res.data.dns_target)}`);
  console.log();

  if (options.noWait) {
    console.log(pc.yellow('  ! --no-wait — skipping cert poll. Run `amba sites describe` later.'));
    return;
  }

  // Poll cert_status via the control DB. The proxy + cert-refresh
  // background flow updates the row server-side; we just read.
  const timeout = (options.timeout ?? 600) * 1000;
  const start = Date.now();
  let lastStatus: SiteDomainRow['cert_status'] | '' = '';
  while (Date.now() - start < timeout) {
    const domains = await listSiteDomains(projectId, options.site);
    const row = domains.data.find((d) => d.hostname === hostname);
    if (!row) {
      // Shouldn't happen — the row was just persisted server-side.
      throw new Error(`Domain ${hostname} disappeared from listing — check API state.`);
    }
    if (row.cert_status !== lastStatus) {
      console.log(pc.dim(`  cert_status: ${formatCertStatus(row.cert_status)}`));
      lastStatus = row.cert_status;
    }
    if (row.cert_status === 'active') {
      console.log(pc.green('  ✓') + ` ${hostname} live with valid cert.`);
      return;
    }
    if (row.cert_status === 'error') {
      throw new Error(
        `Cert provisioning failed for ${hostname}. Check that the CNAME points at ${res.data.dns_target}.`,
      );
    }
    await sleep(5_000);
  }
  console.log(
    pc.yellow(
      `  ! Timed out after ${options.timeout ?? 600}s waiting for cert. Re-run \`amba sites describe ${options.site}\` to check status.`,
    ),
  );
}

export async function sitesDomainListCommand(siteName: string): Promise<void> {
  validateSiteName(siteName);
  const projectConfig = await loadProjectConfig();
  const res = await listSiteDomains(projectConfig.projectId, siteName);
  console.log();
  if (res.data.length === 0) {
    console.log(pc.dim(`  No domains attached to ${siteName}.`));
    console.log();
    return;
  }
  for (const d of res.data) {
    console.log(`  ${pc.bold(d.hostname)}  ${formatCertStatus(d.cert_status)}`);
  }
  console.log();
}

export async function sitesDomainRemoveCommand(
  hostname: string,
  options: { site: string; zoneId?: string },
): Promise<void> {
  validateSiteName(options.site);
  validateHostname(hostname);
  const projectConfig = await loadProjectConfig();

  // Single proxy call. Server-side handles both the custom-hostname
  // deletion and the site_domains row deletion. Idempotent on
  // already-removed (returns 200 with deleted: true). The `--zone-id`
  // option is a no-op kept for backward CLI compat.
  void options.zoneId;
  await removeSiteDomainViaApi(projectConfig.projectId, options.site, hostname);
  console.log(pc.green('  ✓') + ` Detached ${hostname} from ${options.site}.`);
}

// ─── disable / archive ─────────────────────────────────────────────────

export async function sitesDisableCommand(name: string): Promise<void> {
  validateSiteName(name);
  const projectConfig = await loadProjectConfig();
  await updateSite(projectConfig.projectId, name, { status: 'disabled' });
  console.log(pc.green('  ✓') + ` Disabled ${name}.`);
}

export async function sitesEnableCommand(name: string): Promise<void> {
  validateSiteName(name);
  const projectConfig = await loadProjectConfig();
  await updateSite(projectConfig.projectId, name, { status: 'active' });
  console.log(pc.green('  ✓') + ` Re-enabled ${name}.`);
}

export async function sitesArchiveCommand(
  name: string,
  options: { confirm?: string } = {},
): Promise<void> {
  validateSiteName(name);
  if (!options.confirm || options.confirm !== name) {
    throw new Error(
      `Archive is destructive. Pass --confirm ${name} to proceed. The site project will be removed and traffic will 404.`,
    );
  }
  const projectConfig = await loadProjectConfig();

  // Server-side cascade: removes attached custom hostnames, tears down
  // the CDN project, and soft-deletes the site row. Partial failures
  // bubble up as 503 with a cascade summary the operator can retry.
  const res = await deleteSiteViaApi(projectConfig.projectId, name, { confirm: name });
  const cascade = res.data.cascade;
  console.log(pc.green('  ✓') + ` Archived ${name}.`);
  console.log(
    pc.dim(
      `    Cascade: domains_removed=${cascade.domains_removed ?? 0}, cf_pages_project_deleted=${cascade.cf_pages_project_deleted ?? false}`,
    ),
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

interface SiteFile {
  /** Path relative to the input dir, with forward slashes. */
  relPath: string;
  absPath: string;
  size: number;
}

/**
 * Sites are static-only. Dynamic logic belongs in `amba functions deploy`;
 * Pages-Functions inputs are rejected before upload so customer code
 * cannot bypass the platform's auth/edge router by smuggling itself
 * into the static-site deployment surface.
 */
const BLOCKED_FILE_NAMES = new Set([
  '_worker.js',
  '_worker.ts',
  '_worker.mjs',
  '_routes.json',
  '_middleware.js',
  '_middleware.ts',
]);
const BLOCKED_DIR_NAMES = new Set(['functions']);

/**
 * Recursively walk `dir` and return every file, skipping common build
 * detritus (`.DS_Store`, `.git`). Dynamic-handler inputs (`_worker.*`,
 * `functions/`, `_routes.json`, `_middleware.*`) are rejected.
 */
async function collectFiles(dir: string): Promise<SiteFile[]> {
  const out: SiteFile[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const p = join(current, e.name);
      if (e.name === '.DS_Store' || e.name === '.git') continue;

      // Reject dynamic-handler inputs anywhere in the tree.
      if (e.isDirectory() && BLOCKED_DIR_NAMES.has(e.name) && depth === 0) {
        throw new SitesStaticOnlyError(
          `Found '${e.name}/' directory at the deploy root. Dynamic handlers are not allowed in static sites.\n` +
            `  → Move dynamic logic to its own function: \`amba functions deploy <entry>\`\n` +
            `  → Then call it from your static site via fetch().`,
        );
      }
      if (e.isFile() && BLOCKED_FILE_NAMES.has(e.name)) {
        throw new SitesStaticOnlyError(
          `Found '${e.name}' in the deploy directory. Dynamic handlers are not allowed in static sites.\n` +
            `  → Move dynamic logic to: \`amba functions deploy <entry>\`\n` +
            `  → Then call it from your static site via fetch().`,
        );
      }

      if (e.isDirectory()) {
        await walk(p, depth + 1);
      } else if (e.isFile()) {
        const st = await stat(p);
        if (st.size > MAX_FILE_BYTES) {
          throw new Error(
            `File ${p} is ${formatBytes(st.size)} (> ${formatBytes(MAX_FILE_BYTES)} per-file cap).`,
          );
        }
        out.push({
          relPath: relative(dir, p).split(/[\\/]/).join('/'),
          absPath: p,
          size: st.size,
        });
      }
    }
  }
  await walk(dir, 0);
  return out;
}

/**
 * Distinct error class so tests can assert on the specific Decision
 * Log #10 rejection rather than string-matching the message. CLI's
 * `runAction` wrapper renders Errors uniformly so users still see the
 * full message.
 */
export class SitesStaticOnlyError extends Error {
  readonly code = 'SITES_STATIC_ONLY' as const;
}

/**
 * Build the multipart payload the deployment proxy expects: one form
 * part per file plus a required `manifest` field mapping
 * `/relative/path` → `sha256-hex`. Leading slash on the manifest key is
 * required.
 */
async function buildPagesDeploymentForm(files: SiteFile[]): Promise<FormData> {
  const fd = new FormData();
  const manifest: Record<string, string> = {};
  for (const f of files) {
    const buf = await readFile(f.absPath);
    // Force a Uint8Array → Blob conversion so the FormData carries
    // binary cleanly. (In Node 22, Blob accepts Uint8Array directly.)
    fd.append(f.relPath, new Blob([new Uint8Array(buf)]), f.relPath);
    // CF keys manifest by absolute path inside the deployment tree.
    // Normalize Windows-style backslashes to forward (relative paths
    // produced by `relative()` on POSIX already use `/`).
    const manifestKey = '/' + f.relPath.split(/[/\\]/).join('/');
    manifest[manifestKey] = createHash('sha256').update(buf).digest('hex');
  }
  fd.append('manifest', JSON.stringify(manifest));
  return fd;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatCertStatus(s: string): string {
  if (s === 'active') return pc.green(s);
  if (s === 'error') return pc.red(s);
  return pc.yellow(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Test-only re-export of internal helpers. Tests reach in via this
 * namespace so the production module surface stays clean. Not a public
 * API — anything here is unstable across patches.
 */
export const __testHelpers = {
  collectFiles,
  BLOCKED_FILE_NAMES,
  BLOCKED_DIR_NAMES,
};
