/**
 * `amba functions logs <name>` — read recent log events.
 *
 * Two modes:
 *   - One-shot (default): fetch events in `[since, until)` and exit.
 *   - `--tail`: print the last hour's events, then poll every 3s for
 *     new events past the highest seen `EventTimestampMs`. Ctrl+C to stop.
 *
 * Output formatting:
 *   - `--json`: NDJSON to stdout (one event per line) so `| jq` works.
 *   - default: human-readable lines:
 *       2026-05-08T12:34:56.789Z scan-letter-v3 [info] "scanning"
 *       2026-05-08T12:34:57.012Z scan-letter-v3 [exception] TypeError: …
 *
 * Server-side scoping is enforced — the API filters by ScriptName
 * prefix so a developer can never read another tenant's logs.
 */

import pc from 'picocolors';
import { getFunctionLogs, type FunctionLogEvent } from '../api-client.js';
import { loadProjectConfig } from '../project-config.js';

export interface FunctionsLogsOptions {
  /** ISO 8601 inclusive start. Defaults to 1 hour ago (or last-seen on tail). */
  since?: string;
  /** ISO 8601 exclusive end. Defaults to now. Ignored on tail. */
  until?: string;
  /** Max events per fetch. Default 100, max 1000. */
  limit?: number;
  /** Tail mode — poll every 3s. */
  tail?: boolean;
  /** NDJSON output. */
  json?: boolean;
}

const TAIL_POLL_MS = 3_000;

export async function functionsLogsCommand(
  functionName: string,
  options: FunctionsLogsOptions = {},
): Promise<void> {
  const projectConfig = await loadProjectConfig();

  if (options.tail) {
    await runTail(projectConfig.projectId, functionName, options);
    return;
  }

  const res = await getFunctionLogs(projectConfig.projectId, functionName, {
    since: options.since,
    until: options.until,
    limit: options.limit,
  });
  printEvents(res.data.events, options.json);
  if (res.data.truncated) {
    if (options.json) {
      // Add a single `{"truncated": true}` marker on stderr so a `| jq`
      // pipeline doesn't ingest it as data — stderr is the right channel.
      process.stderr.write(`{"truncated":true}\n`);
    } else {
      console.error(
        pc.yellow(`  ! Result truncated at limit; narrow --since / --until or raise --limit.`),
      );
    }
  }
}

async function runTail(
  projectId: string,
  functionName: string,
  options: FunctionsLogsOptions,
): Promise<void> {
  // Initial fetch — last hour by default. Customer can pass --since to
  // backfill more on tail's first tick.
  let sinceMs = options.since ? Date.parse(options.since) : Date.now() - 60 * 60 * 1000;
  if (Number.isNaN(sinceMs)) {
    throw new Error('--since must be a valid ISO 8601 timestamp');
  }

  if (!options.json) {
    console.error(
      pc.dim(
        `  Tailing ${functionName} — Ctrl+C to stop. Initial backfill from ${new Date(sinceMs).toISOString()}.`,
      ),
    );
  }

  // Track the highest `EventTimestampMs` we've printed so the next
  // poll's `since` strictly excludes already-shown rows. Add a small
  // 1ms increment so we don't re-emit boundary events.
  let highWaterMs = sinceMs;
  for (;;) {
    let result;
    try {
      result = await getFunctionLogs(projectId, functionName, {
        since: new Date(highWaterMs).toISOString(),
        // No `until` → server defaults to `now`.
        limit: options.limit ?? 200,
      });
    } catch (err) {
      // Don't kill the tail on a transient API error. Print to stderr
      // and back off for the same poll interval.
      console.error(
        pc.yellow(`  ! tail fetch failed: `) + (err instanceof Error ? err.message : String(err)),
      );
      await sleep(TAIL_POLL_MS);
      continue;
    }
    if (result.data.events.length > 0) {
      printEvents(result.data.events, options.json);
      // Highest timestamp + 1ms so the next request's `since` filter
      // skips anything we just printed.
      const maxTs = result.data.events.reduce(
        (m, e) => Math.max(m, e.EventTimestampMs ?? 0),
        highWaterMs,
      );
      highWaterMs = maxTs + 1;
    }
    await sleep(TAIL_POLL_MS);
  }
}

function printEvents(events: FunctionLogEvent[], asJson?: boolean): void {
  // The API returns newest-first; print in chronological (oldest-first)
  // order so terminal scroll flows naturally.
  const ordered = [...events].sort((a, b) => (a.EventTimestampMs ?? 0) - (b.EventTimestampMs ?? 0));
  if (asJson) {
    for (const e of ordered) process.stdout.write(JSON.stringify(e) + '\n');
    return;
  }
  for (const e of ordered) {
    const ts = e.EventTimestampMs
      ? new Date(e.EventTimestampMs).toISOString()
      : '????-??-??T??:??:??Z';
    const script = e.ScriptName ?? '<unknown-script>';
    if (e.Logs && e.Logs.length > 0) {
      for (const logLine of e.Logs) {
        const level = renderLevel(logLine.Level);
        const msg = renderMessage(logLine.Message);
        console.log(`${pc.dim(ts)} ${pc.cyan(script)} ${level} ${msg}`);
      }
    }
    if (e.Exceptions && e.Exceptions.length > 0) {
      for (const ex of e.Exceptions) {
        console.log(
          `${pc.dim(ts)} ${pc.cyan(script)} ${pc.red('[exception]')} ${ex.Name ?? 'Error'}: ${ex.Message ?? ''}`,
        );
      }
    }
    // Outcome-only events (no Logs, no Exceptions) — surface for
    // operational visibility (e.g. `cancelled`, `exceededCpu`).
    if (
      (!e.Logs || e.Logs.length === 0) &&
      (!e.Exceptions || e.Exceptions.length === 0) &&
      e.Outcome &&
      e.Outcome !== 'ok'
    ) {
      console.log(`${pc.dim(ts)} ${pc.cyan(script)} ${pc.yellow('[outcome]')} ${e.Outcome}`);
    }
  }
}

function renderLevel(level: string | undefined): string {
  switch (level) {
    case 'error':
      return pc.red('[error]');
    case 'warn':
      return pc.yellow('[warn]');
    case 'log':
    case 'info':
      return pc.green('[info]');
    case 'debug':
      return pc.dim('[debug]');
    default:
      return pc.dim(`[${level ?? 'info'}]`);
  }
}

function renderMessage(parts: unknown[] | undefined): string {
  if (!parts || parts.length === 0) return '';
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
