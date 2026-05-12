import { createWriteStream, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import {
  listProjectEvents,
  streamUsersExport,
  ApiClientError,
  type AdminEventRow,
} from '../api-client.js';
import { requireProjectId } from '../env.js';

export type AnalyticsType = 'users' | 'events';
export type AnalyticsFormat = 'csv' | 'ndjson';

export interface AnalyticsExportOptions {
  type: AnalyticsType;
  project?: string;
  since?: string;
  until?: string;
  out?: string;
  limit?: number;
  format?: AnalyticsFormat;
  /** Test seam: cap the number of pages walked when paginating events. */
  maxPages?: number;
}

const PAGE_SIZE = 1000;
const PROGRESS_EVERY = 500;

// ─── CSV helpers ─────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'string') {
    s = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    s = String(value);
  } else {
    s = JSON.stringify(value);
  }
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\n';
}

// ─── Output sink ────────────────────────────────────────────────────

interface Sink {
  write(chunk: string): void | Promise<void>;
  close(): Promise<void>;
}

function makeSink(out: string | undefined): { sink: Sink; resolvedPath: string | null } {
  if (!out) {
    return {
      resolvedPath: null,
      sink: {
        write(chunk) {
          process.stdout.write(chunk);
        },
        async close() {
          /* stdout doesn't close */
        },
      },
    };
  }
  const resolvedPath = resolve(process.cwd(), out);
  const stream: WriteStream = createWriteStream(resolvedPath, { encoding: 'utf-8' });
  const sink: Sink = {
    write(chunk) {
      stream.write(chunk);
    },
    close() {
      return new Promise<void>((res, rej) => {
        stream.end((err?: Error | null) => (err ? rej(err) : res()));
      });
    },
  };
  return { sink, resolvedPath };
}

function progress(rowsEmitted: number, force = false): void {
  if (!force && rowsEmitted % PROGRESS_EVERY !== 0) return;
  if (!process.stderr.isTTY && !force) return;
  // Emit to stderr so piping stdout to a file isn't polluted.
  process.stderr.write(pc.dim(`  … ${rowsEmitted} rows emitted\r`));
}

// ─── Users export ───────────────────────────────────────────────────

async function exportUsers(projectId: string, opts: AnalyticsExportOptions): Promise<void> {
  const fmt: AnalyticsFormat = opts.format ?? 'csv';
  const { sink, resolvedPath } = makeSink(opts.out);

  let res;
  try {
    res = await streamUsersExport(projectId, { format: fmt, since: opts.since });
  } catch (err) {
    await sink.close();
    throw err;
  }

  const body = res.body;
  if (!body) {
    await sink.close();
    throw new Error('Server returned an empty users export stream');
  }

  // Stream the response straight through to the sink. We don't try to
  // re-parse the body — the API decided the format already.
  let bytes = 0;
  let lines = 0;
  let pending = '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    bytes += chunk.length;
    pending += chunk;
    let idx;
    while ((idx = pending.indexOf('\n')) >= 0) {
      lines++;
      pending = pending.slice(idx + 1);
      if (lines % PROGRESS_EVERY === 0) progress(lines);
    }
    sink.write(chunk);
  }
  if (pending.length > 0) {
    sink.write(pending);
  }
  await sink.close();

  if (process.stderr.isTTY) process.stderr.write('\n');
  if (resolvedPath) {
    console.log(pc.green('  ✓') + ` Wrote ${resolvedPath}`);
    console.log(pc.dim(`    ${lines} line${lines === 1 ? '' : 's'} (${bytes} bytes)`));
  }
}

// ─── Events export ──────────────────────────────────────────────────

function eventToCsv(ev: AdminEventRow): string {
  return csvRow([
    ev.id,
    ev.app_user_id,
    ev.event_name,
    ev.occurred_at,
    JSON.stringify(ev.properties ?? {}),
  ]);
}

async function exportEvents(projectId: string, opts: AnalyticsExportOptions): Promise<void> {
  const fmt: AnalyticsFormat = opts.format ?? 'csv';
  const { sink, resolvedPath } = makeSink(opts.out);

  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = opts.until ?? new Date().toISOString();

  if (fmt === 'csv') {
    sink.write(csvRow(['id', 'app_user_id', 'event_name', 'occurred_at', 'properties']));
  }

  let cursor: string | null = null;
  let rows = 0;
  let pages = 0;
  const maxPages = opts.maxPages ?? Infinity;

  try {
    do {
      pages++;
      const page = await listProjectEvents(projectId, {
        since,
        until,
        limit: opts.limit ?? PAGE_SIZE,
        cursor: cursor ?? undefined,
      });
      for (const ev of page.data) {
        if (fmt === 'ndjson') {
          sink.write(JSON.stringify(ev) + '\n');
        } else {
          sink.write(eventToCsv(ev));
        }
        rows++;
        if (rows % PROGRESS_EVERY === 0) progress(rows);
      }
      cursor = page.next_cursor;
      if (pages >= maxPages) break;
    } while (cursor);
  } finally {
    await sink.close();
  }

  if (process.stderr.isTTY) process.stderr.write('\n');
  if (resolvedPath) {
    console.log(pc.green('  ✓') + ` Wrote ${resolvedPath}`);
    console.log(pc.dim(`    ${rows} event${rows === 1 ? '' : 's'} across ${pages} page(s)`));
  } else if (rows > 0) {
    // For stdout exports, give the operator a hint to stderr.
    process.stderr.write(pc.dim(`  ${rows} event${rows === 1 ? '' : 's'} emitted\n`));
  }
}

// ─── Entry ──────────────────────────────────────────────────────────

export async function analyticsExportCommand(opts: AnalyticsExportOptions): Promise<void> {
  const cwd = process.cwd();
  const projectId = await requireProjectId(cwd, opts.project);

  if (opts.type !== 'users' && opts.type !== 'events') {
    console.log();
    console.log(pc.red('  ✗') + ` Unknown --type: ${String(opts.type)}`);
    console.log(pc.dim('    Valid: users, events'));
    console.log();
    process.exit(1);
  }

  if (opts.format && opts.format !== 'csv' && opts.format !== 'ndjson') {
    console.log();
    console.log(pc.red('  ✗') + ` Unknown --format: ${String(opts.format)}`);
    console.log(pc.dim('    Valid: csv, ndjson'));
    console.log();
    process.exit(1);
  }

  // Header lines go to stderr so stdout stays a clean CSV/NDJSON stream.
  process.stderr.write('\n');
  process.stderr.write(pc.bold(`  amba analytics export --type=${opts.type}`) + '\n');
  process.stderr.write(pc.dim('  ─────────────────────────────────') + '\n');
  process.stderr.write(pc.dim(`  Project: ${projectId}`) + '\n');
  process.stderr.write('\n');

  try {
    if (opts.type === 'users') {
      await exportUsers(projectId, opts);
    } else {
      await exportEvents(projectId, opts);
    }
    console.log();
  } catch (err) {
    if (err instanceof ApiClientError) {
      console.log(pc.red('  ✗') + ` ${err.message}`);
    } else if (err instanceof Error) {
      console.log(pc.red('  ✗') + ` ${err.message}`);
    }
    console.log();
    process.exit(1);
  }
}
