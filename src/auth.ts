import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import open from 'open';
import pc from 'picocolors';
import { CONSOLE_URL } from './_internal/shared.js';

export interface Credentials {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

const AMBA_DIR = join(homedir(), '.amba');
const CREDENTIALS_PATH = join(AMBA_DIR, 'credentials.json');

/**
 * Personal Access Token prefix — `amb_dpat_` followed by 32 random
 * characters. The CLI accepts a PAT via the `--token <pat>` flag or the
 * `AMBA_PAT` env var as a stored-credentials replacement, enabling
 * headless / CI / agent use without the browser flow.
 */
export const PAT_PREFIX = 'amb_dpat_';

/**
 * Shape check for a PAT. The platform mints PATs as `amb_dpat_` plus 32
 * characters from the base64url alphabet (`[A-Za-z0-9_-]`) per
 * RFC 4648 §5.
 */
function isPatShape(token: string): boolean {
  return /^amb_dpat_[A-Za-z0-9_-]{32}$/.test(token);
}

/**
 * Start a temporary local HTTP server, open the browser for OAuth,
 * and wait for the redirect callback carrying the token.
 */
export async function browserAuthFlow(): Promise<Credentials> {
  return new Promise<Credentials>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const accessToken = url.searchParams.get('access_token');
      const refreshToken = url.searchParams.get('refresh_token');
      const expiresAt = url.searchParams.get('expires_at');

      if (!accessToken || !refreshToken || !expiresAt) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>Authentication failed</h2><p>Missing token parameters. Please try again.</p></body></html>',
        );
        server.close();
        reject(new Error('Missing token parameters in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body style="font-family:system-ui;text-align:center;padding:3rem">' +
          '<h2>Authenticated!</h2>' +
          '<p>You can close this window and return to the terminal.</p>' +
          '</body></html>',
      );

      const creds: Credentials = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
      };

      server.close();
      resolve(creds);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to start local auth server'));
        return;
      }

      const port = addr.port;
      const authUrl = `${CONSOLE_URL}/cli-login?port=${port}`;

      console.log(pc.dim(`  Opening browser to authenticate...`));
      console.log(pc.dim(`  ${authUrl}`));
      console.log();

      open(authUrl).catch(() => {
        console.log(pc.yellow(`  Could not open browser automatically.`));
        console.log(pc.yellow(`  Please open this URL manually:`));
        console.log(`  ${pc.underline(authUrl)}`);
      });

      // Timeout after 2 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('Authentication timed out. Please try again.'));
      }, 120_000);
    });
  });
}

/**
 * Store credentials to ~/.amba/credentials.json
 */
export async function storeCredentials(creds: Credentials): Promise<void> {
  await mkdir(AMBA_DIR, { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), 'utf-8');
}

/**
 * Load stored credentials. Throws if not found.
 */
export async function loadCredentials(): Promise<Credentials> {
  try {
    const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('access_token' in parsed) ||
      !('refresh_token' in parsed) ||
      !('expires_at' in parsed)
    ) {
      throw new Error('Invalid credentials format');
    }

    const creds = parsed as Credentials;

    if (!creds.access_token || typeof creds.access_token !== 'string') {
      throw new Error('Missing or invalid access_token in credentials');
    }

    return creds;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Credentials not found. Run ${pc.bold('amba login')} to authenticate first, or pass ${pc.bold('--token <pat>')} / set ${pc.bold('AMBA_PAT')} for headless invocations.`,
      );
    }
    throw err;
  }
}

/**
 * Check if the access token is expired (with 60s buffer).
 */
export function isTokenExpired(creds: Credentials): boolean {
  if (!creds.expires_at) return false;
  const expiresAt = new Date(creds.expires_at).getTime();
  return Date.now() > expiresAt - 60_000;
}

/**
 * Remove stored credentials.
 */
export async function clearCredentials(): Promise<void> {
  try {
    await rm(CREDENTIALS_PATH, { force: true });
  } catch {
    // Ignore if file doesn't exist
  }
}

// ─── Headless / agent auth ──────────────────────────────────────────────
//
// Every command can be invoked headlessly by passing
// a PAT via either `--token <pat>` flag or `AMBA_PAT` env var. The
// resolver below applies a strict precedence:
//
//   1. explicit `--token <pat>` flag        (highest — operator override)
//   2. `AMBA_PAT` env var                   (CI / agent default)
//   3. stored creds at ~/.amba/credentials.json   (interactive default)
//
// (1) and (2) skip the expiry check entirely — PATs are long-lived and
// only invalidate on rotation. The stored-creds path keeps the existing
// 60s-buffer expiry check for short-lived JWT access tokens minted by
// the browser flow.
//
// `--token` always wins over `AMBA_PAT` so a one-off command like
// `amba projects list --token amb_dpat_<other-team's-pat>` works
// without the operator having to unset their AMBA_PAT shell var. Every
// command path that hits the API funnels through `resolveBearerToken`
// (called from the api-client `request` helper); the optional flag is
// threaded through commander.js's `preAction` hook, see `index.ts`.

/**
 * Process-scoped override for the bearer token used on admin API
 * calls. Set by the commander.js `preAction` hook in `index.ts`
 * before any subcommand runs — non-empty here means "skip stored
 * creds, use this PAT/JWT verbatim." Cleared on test teardown via
 * `__resetTokenOverride` to keep test cases isolated.
 */
let bearerOverride: string | null = null;

/**
 * Set the process-scoped bearer override. Called by the global
 * `preAction` hook with the resolved value (flag → env → null).
 * `null` clears any prior override.
 */
export function setBearerOverride(token: string | null): void {
  bearerOverride = token === null || token.length === 0 ? null : token;
}

/** Test-only: reset the override between cases. */
export function __resetTokenOverride(): void {
  bearerOverride = null;
}

/**
 * Resolve the bearer token to send on the next admin API call.
 *
 * Returns the override (PAT or JWT supplied via flag/env) when set,
 * otherwise loads + expiry-checks the stored access token. Throws
 * with an actionable error message in either failure path.
 */
export async function resolveBearerToken(): Promise<string> {
  // (1) + (2) — explicit override path. The override is the resolved
  // value of `--token` (preferred) → `AMBA_PAT` (fallback). Both have
  // already been merged by the time this runs; we just consume.
  if (bearerOverride !== null) {
    if (isPatShape(bearerOverride)) {
      // PAT shape — long-lived, no expiry check.
      return bearerOverride;
    }
    // Could be a developer JWT (`eyJ…`) — adminAuth accepts both. We
    // don't try to parse JWT expiry on the CLI side; if it's expired,
    // the API will 401 with a clear message and the operator re-auths.
    return bearerOverride;
  }

  // (3) — stored credentials path (interactive flow).
  const creds = await loadCredentials();
  if (isTokenExpired(creds)) {
    throw new Error(
      `Session expired. Run ${pc.bold('amba login')} to re-authenticate, or pass ${pc.bold('--token <pat>')} / set ${pc.bold('AMBA_PAT')} for headless invocations.`,
    );
  }
  return creds.access_token;
}

/**
 * Compute the bearer-override value the CLI should install for this
 * invocation. Pure function — exported for testability. Caller wires
 * the result into `setBearerOverride` (typically inside commander's
 * `preAction` hook in `index.ts`).
 *
 *   resolveTokenSource({ flagToken: '...', envToken: '...' })
 *     → flag wins
 *
 *   resolveTokenSource({ envToken: '...' })
 *     → env used
 *
 *   resolveTokenSource({})
 *     → null (CLI falls back to stored creds at request time)
 */
export interface ResolveTokenSourceInput {
  flagToken?: string | undefined;
  envToken?: string | undefined;
}

export function resolveTokenSource(input: ResolveTokenSourceInput): string | null {
  const flag = input.flagToken?.trim();
  if (flag) return flag;
  const env = input.envToken?.trim();
  if (env) return env;
  return null;
}
