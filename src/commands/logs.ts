import pc from 'picocolors';
import { requireProjectId } from '../env.js';
import { listProjectEvents, ApiClientError, type AdminEventRow } from '../api-client.js';

export interface LogsTailOptions {
  project?: string;
  follow?: boolean;
  json?: boolean;
  since?: string;
  eventName?: string;
  userId?: string;
  limit?: number;
  /** Polling interval in ms when --follow is set. Tests inject a small value. */
  pollIntervalMs?: number;
  /** Test seam: stop polling after N iterations. Production callers omit. */
  maxFollowIterations?: number;
  /** Test seam: AbortSignal to terminate the follow loop cleanly. */
  signal?: AbortSignal;
}

const DEFAULT_TAIL_LIMIT = 100;
const DEFAULT_POLL_INTERVAL_MS = 2000;

function compactProperties(props: Record<string, unknown> | null | undefined): string {
  if (!props || typeof props !== 'object') return '';
  const keys = Object.keys(props);
  if (keys.length === 0) return '';
  return JSON.stringify(props);
}

function formatEvent(ev: AdminEventRow): string {
  const ts = ev.occurred_at;
  const user = ev.app_user_id;
  const props = compactProperties(ev.properties);
  const tail = props ? ` ${pc.dim(props)}` : '';
  // Keep the `user=<id>` pair as a single dim span. Splitting the dim wrapper
  // around the value (`pc.dim('user=') + user`) inserts an ANSI reset between
  // them in color-on environments (CI, TTY), which breaks both readability
  // and `toContain('user=u1')`-style assertions on the rendered output.
  return `${pc.dim(ts)} ${pc.cyan(ev.event_name)} ${pc.dim(`user=${user}`)}${tail}`;
}

function emitEvent(ev: AdminEventRow, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(ev) + '\n');
  } else {
    console.log(formatEvent(ev));
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort);
    }
  });
}

export async function logsTailCommand(opts: LogsTailOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const projectId = await requireProjectId(cwd, opts.project);

  const json = opts.json ?? false;
  const limit = opts.limit ?? DEFAULT_TAIL_LIMIT;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  if (!json) {
    console.log();
    console.log(pc.bold('  amba logs tail'));
    console.log(pc.dim('  ─────────────────────────────────'));
    console.log();
    console.log(pc.dim(`  Project: ${projectId}`));
    console.log(pc.dim(`  Since:   ${since}`));
    if (opts.eventName) console.log(pc.dim(`  Event:   ${opts.eventName}`));
    if (opts.userId) console.log(pc.dim(`  User:    ${opts.userId}`));
    console.log();
  }

  // First page: most-recent-first. We need chronological order on screen.
  let page;
  try {
    page = await listProjectEvents(projectId, {
      since,
      eventName: opts.eventName,
      userId: opts.userId,
      limit,
    });
  } catch (err) {
    if (err instanceof ApiClientError) {
      console.error(pc.red('  ✗') + ` ${err.message}`);
    } else if (err instanceof Error) {
      console.error(pc.red('  ✗') + ` ${err.message}`);
    } else {
      console.error(pc.red('  ✗') + ' Failed to fetch events');
    }
    process.exit(1);
  }

  const initial = [...page.data].reverse();
  if (initial.length === 0 && !json) {
    console.log(pc.dim('  (no events in window)'));
  } else {
    for (const ev of initial) {
      emitEvent(ev, json);
    }
  }

  if (!opts.follow) {
    if (!json) console.log();
    return;
  }

  // Track the most-recent occurred_at we've already emitted; the next poll
  // uses it as `since` so we don't double-print events. Add 1ms to avoid
  // re-fetching the boundary row (the API uses >= since).
  let lastTs = initial.length > 0 ? initial[initial.length - 1]!.occurred_at : since;
  const seenIds = new Set<string>(initial.map((e) => e.id));

  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxIters = opts.maxFollowIterations ?? Infinity;

  // Wire SIGINT for clean exit. Tests use --maxFollowIterations / --signal
  // instead so they don't have to send signals.
  const ac = new AbortController();
  let sigintHandler: (() => void) | null = null;
  if (!opts.signal) {
    sigintHandler = (): void => {
      ac.abort();
    };
    process.once('SIGINT', sigintHandler);
  }
  const followSignal = opts.signal ?? ac.signal;

  let iters = 0;
  while (!followSignal.aborted && iters < maxIters) {
    await delay(pollMs, followSignal);
    if (followSignal.aborted) break;
    iters++;

    let newPage;
    try {
      newPage = await listProjectEvents(projectId, {
        since: lastTs,
        eventName: opts.eventName,
        userId: opts.userId,
        limit,
      });
    } catch (err) {
      // Transient errors during follow shouldn't kill the stream; surface
      // and keep going. Permission/auth errors will recur every poll, which
      // is the correct loud behavior for the operator.
      if (err instanceof ApiClientError) {
        console.error(pc.yellow('  !') + ` poll error: ${err.message}`);
      } else if (err instanceof Error) {
        console.error(pc.yellow('  !') + ` poll error: ${err.message}`);
      }
      continue;
    }

    const fresh = [...newPage.data].reverse().filter((e) => !seenIds.has(e.id));
    for (const ev of fresh) {
      seenIds.add(ev.id);
      emitEvent(ev, json);
      lastTs = ev.occurred_at;
    }
  }

  if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
  if (!json) {
    console.log();
    console.log(pc.dim('  (follow stopped)'));
    console.log();
  }
}
