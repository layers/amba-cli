/**
 * `amba collections ...` — thin shells over the admin collection routes.
 *
 * Wire shapes:
 *
 *   POST   /admin/projects/:p/collections             — create (full schema)
 *   GET    /admin/projects/:p/collections             — list
 *   PATCH  /admin/projects/:p/collections/:name       — single-op alter
 *   DELETE /admin/projects/:p/collections/:name       — drop (requires ?confirm)
 *
 * The CLI's job is to:
 *   1. Validate names / types client-side so an obviously-bad invocation
 *      doesn't round-trip.
 *   2. Translate the user-friendly CLI flag shape (`--field name:type`,
 *      `--add-field`, `--drop-field`) into the wire shape (single op per
 *      PATCH).
 *   3. Block until the server reports success.
 *   4. Surface server errors with a sensible CLI message.
 *
 * Multi-op alters are issued sequentially so the operator audit trail
 * stays one-to-one with developer actions.
 */

import pc from 'picocolors';
import {
  alterCollection,
  createCollection,
  dropCollection,
  listCollections,
  type CollectionColumn,
  type CollectionColumnType,
  type CollectionIndex,
} from '../api-client.js';
import { loadProjectConfig } from '../project-config.js';
import { getReservationReason } from '../_internal/shared.js';

/**
 * Closed-set type catalog. Matches data's `ColumnType` exactly — keeps
 * the CLI fail-fast path aligned with the DDL emit's accepted shapes.
 *
 * The CLI accepts customer-friendly synonyms (e.g. `int` → `integer`)
 * via `normalizeColumnType` so the `--field` flag stays ergonomic
 * without the API needing to relax its closed catalog.
 */
const ALLOWED_TYPES = new Set<CollectionColumnType>([
  'uuid',
  'text',
  'integer',
  'bigint',
  'numeric',
  'boolean',
  'timestamptz',
  'date',
  'jsonb',
  // pgvector. The dimension is mandatory and is parsed from the
  // field-spec syntax `name:vector:N` (or `name:vector(N)` to align
  // with PostgreSQL's literal syntax). 1 ≤ dimension ≤ 4096.
  'vector',
]);

const TYPE_SYNONYMS: Record<string, CollectionColumnType> = {
  // Customer-facing aliases for ergonomics — mapped to data's canonical names.
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  bool: 'boolean',
  json: 'jsonb', // jsonb is the only JSON path in v1; alias `json` for ergonomics.
  string: 'text',
};

// ─── create ────────────────────────────────────────────────────────────

export interface CollectionsCreateOptions {
  /** Field specs in `name:type[:nullable]` form. May repeat. */
  field: string[];
  /** Index specs — one or more comma-separated `<col> [asc|desc]` entries. */
  index: string[];
}

export async function collectionsCreateCommand(
  name: string,
  options: CollectionsCreateOptions,
): Promise<void> {
  const reason = getReservationReason(name);
  if (reason) throw new Error(`Cannot create collection '${name}': ${reason}`);

  const columns = options.field.map(parseColumnSpec);
  const indexes = options.index.map(parseIndexSpec);

  const projectConfig = await loadProjectConfig();
  console.log();
  console.log(pc.bold(`  amba collections create ${pc.cyan(name)}`));
  for (const c of columns) {
    console.log(
      pc.dim('    ') +
        c.name +
        pc.dim(': ') +
        c.type +
        (c.nullable ? pc.dim(' NULL') : pc.dim(' NOT NULL')),
    );
  }
  console.log();

  const res = await createCollection(projectConfig.projectId, {
    name,
    columns,
    indexes,
  });
  console.log(pc.green('  ✓') + ` Created — version ${res.data.version}`);
  console.log(pc.dim(`    workflow_id: ${res.data.workflow_id}`));
  console.log();
}

// ─── alter ─────────────────────────────────────────────────────────────

export interface CollectionsAlterOptions {
  /** Add columns (`name:type[:nullable]`). */
  addField: string[];
  /** Drop columns (by name). DROP COLUMN is destructive — confirm with --confirm. */
  dropField: string[];
  /** Add indexes (same spec syntax as create). */
  addIndex: string[];
  /**
   * Per data's API: drop_column requires `?confirm=<column-name>`. The
   * CLI surfaces this as a flag listing the columns the developer is
   * confirming; we cross-check against `dropField` below.
   */
  confirm?: string[];
}

export async function collectionsAlterCommand(
  name: string,
  options: CollectionsAlterOptions,
): Promise<void> {
  if (
    options.addField.length === 0 &&
    options.dropField.length === 0 &&
    options.addIndex.length === 0
  ) {
    throw new Error(
      'amba collections alter: at least one of --add-field, --add-index, or --drop-field is required.',
    );
  }
  // Per-call confirm guard for destructive drops. Data's API rejects
  // a `drop_column` PATCH without a matching `?confirm=<col>` query
  // param; the CLI mirrors that requirement here so the developer sees
  // the actionable error before the round-trip.
  const confirmed = new Set(options.confirm ?? []);
  for (const col of options.dropField) {
    if (!confirmed.has(col)) {
      throw new Error(
        `Refusing to drop column '${col}' without --confirm ${col} (DROP COLUMN is destructive).`,
      );
    }
  }

  const projectConfig = await loadProjectConfig();

  // Each operation becomes its own PATCH. The server writes one
  // registry row per intent, so multi-op alters produce a clean
  // one-line-per-action audit trail rather than a single batch with
  // ambiguous partial-failure semantics.
  for (const fieldSpec of options.addField) {
    const column = parseColumnSpec(fieldSpec);
    const res = await alterCollection(projectConfig.projectId, name, { add_column: column });
    console.log(
      pc.green('  ✓') +
        ` add column ${pc.cyan(column.name)} (${column.type}) — version ${res.data.version}`,
    );
  }
  for (const indexSpec of options.addIndex) {
    const index = parseIndexSpec(indexSpec);
    const res = await alterCollection(projectConfig.projectId, name, { add_index: index });
    console.log(
      pc.green('  ✓') + ` add index on (${index.columns.join(', ')}) — version ${res.data.version}`,
    );
  }
  for (const col of options.dropField) {
    const res = await alterCollection(
      projectConfig.projectId,
      name,
      { drop_column: col },
      { confirm: col },
    );
    console.log(pc.green('  ✓') + ` drop column ${pc.cyan(col)} — version ${res.data.version}`);
  }
}

// ─── list ──────────────────────────────────────────────────────────────

export async function collectionsListCommand(): Promise<void> {
  const projectConfig = await loadProjectConfig();
  const res = await listCollections(projectConfig.projectId, { limit: 200 });
  console.log();
  if (res.data.length === 0) {
    console.log(pc.dim('  No collections defined.'));
    console.log();
    return;
  }
  for (const c of res.data) {
    console.log(`  ${pc.bold(c.name)}  ` + pc.dim(c.created_at));
  }
  console.log();
}

// ─── drop ──────────────────────────────────────────────────────────────

export async function collectionsDropCommand(
  name: string,
  options: { confirm?: string } = {},
): Promise<void> {
  // Data's API requires `?confirm=<collection-name>` matching the URL
  // path. CLI mirrors this so the developer sees the actionable error
  // up front rather than a 400 from the API.
  if (options.confirm !== name) {
    throw new Error(
      `Refusing to drop ${name}: pass --confirm ${name} to confirm (DROP TABLE is destructive).`,
    );
  }
  const projectConfig = await loadProjectConfig();
  await dropCollection(projectConfig.projectId, name, name);
  console.log(pc.green('  ✓') + ` Dropped ${name}.`);
}

// ─── parsers ───────────────────────────────────────────────────────────

function normalizeColumnType(raw: string): CollectionColumnType {
  // Strip any trailing `(...)` (e.g. `numeric(10,2)` collapses to `numeric`
  // for catalog validation; the trailing precision is preserved on the
  // wire if the API ever accepts it, which today it doesn't).
  const baseRaw = (raw.split('(')[0] ?? raw).trim().toLowerCase();
  const base = (TYPE_SYNONYMS[baseRaw] ?? baseRaw) as CollectionColumnType;
  if (!ALLOWED_TYPES.has(base)) {
    throw new Error(`Unknown type '${raw}'. Allowed: ${[...ALLOWED_TYPES].join(', ')}.`);
  }
  return base;
}

/**
 * Parse a `--field` spec into a `CollectionColumn`.
 *
 * Accepted grammars:
 *
 *   1. **Plain column:** `name:type[:nullable]`
 *      Examples: `letter_id:uuid`, `parsed:jsonb:nullable`.
 *
 *   2. **Foreign key:** `name:type:fk(<table>[.<column>][:onDelete])`
 *      Examples:
 *        `plan_id:uuid:fk(plans)` — references `plans(id)`, default no-action
 *        `plan_id:uuid:fk(plans.id)` — explicit column
 *        `plan_id:uuid:fk(plans.id:cascade)` — ON DELETE CASCADE
 *        `parent_id:uuid:fk(comments:set_null)` — ON DELETE SET NULL
 *
 *      Note: a `user_id` FK to `app_users(id)` is auto-emitted on every
 *      collection server-side. Customers don't need to declare it.
 *
 *   3. **Vector:** `name:vector:<dim>` or `name:vector(<dim>)`
 *      Examples:
 *        `embedding:vector:1536` — OpenAI text-embedding-3-small
 *        `embedding:vector(384)` — sentence-transformers / all-MiniLM
 *      Dimension is validated client-side as 1..4096. For an HNSW /
 *      IVFFlat index on the column, supply `--index 'embedding'`
 *      separately.
 *
 *   4. **Vector + nullable:** `name:vector:<dim>:nullable`
 *      Vector columns can be nullable for "embedding generated lazily".
 *
 * Multi-arg combinations (e.g. fk + nullable on the same column) parse
 * left-to-right: the third segment is the FK / vector / nullable
 * marker; if it's an FK or vector, the optional fourth segment is
 * `nullable`. Plain columns put `nullable` in slot 3.
 */
function parseColumnSpec(spec: string): CollectionColumn {
  // Pre-handle the `vector(N)` paren form by normalizing to `vector:N`
  // before the colon-split. Both forms map to the same wire shape.
  const normalized = spec.replace(/^([a-z_][a-z0-9_]*):vector\((\d+)\)/i, '$1:vector:$2');

  // Pre-handle the `fk(...)` paren form: replace the inner colons with a
  // `|` sentinel so the outer colon-split doesn't shred the fk-args.
  // Round-trip back to colons after slot-extraction.
  const fkSentinel = normalized.replace(/fk\(([^)]+)\)/i, (_match, inner: string) => {
    return `fk(${inner.replace(/:/g, '|')})`;
  });

  const parts = fkSentinel.split(':');
  if (parts.length < 2 || parts.length > 4) {
    throw new Error(
      `Invalid field spec '${spec}'. Grammar:\n` +
        `  name:type[:nullable]                          (plain)\n` +
        `  name:type:fk(table[.col][:onDelete])[:nullable] (foreign key)\n` +
        `  name:vector:<dim>[:nullable]                  (vector / pgvector)\n` +
        `Examples: user_id:uuid, parsed:jsonb:nullable, plan_id:uuid:fk(plans),\n` +
        `          embedding:vector:1536, comment_id:uuid:fk(comments.id:set_null).`,
    );
  }
  const colName = parts[0] as string;
  const type = parts[1] as string;
  const slot3 = parts[2];
  const slot4 = parts[3];

  if (!/^[a-z_][a-z0-9_]*$/.test(colName)) {
    throw new Error(`Invalid column name '${colName}'.`);
  }
  const normalizedType = normalizeColumnType(type);

  const out: CollectionColumn = { name: colName, type: normalizedType };

  // Slot 3 is one of: undefined | 'nullable' | 'fk(...)' | <vector-dim>
  if (slot3 === undefined) {
    if (normalizedType === 'vector') {
      // Vector REQUIRES a dimension. Fail loud rather than ship a
      // malformed insert that would 500 server-side with a less-clear
      // error.
      throw new Error(
        `Vector column '${colName}' requires a dimension. Use ${colName}:vector:<dim> (e.g. ${colName}:vector:1536) or the paren form ${colName}:vector(<dim>).`,
      );
    }
    return out;
  }

  if (normalizedType === 'vector') {
    // For vector columns slot 3 MUST be the dimension (a positive
    // integer). slot 4 may be `nullable`.
    const dim = Number.parseInt(slot3, 10);
    if (!Number.isFinite(dim) || dim <= 0) {
      throw new Error(
        `Invalid vector dimension '${slot3}' on column '${colName}'. Expected a positive integer (e.g. embedding:vector:1536).`,
      );
    }
    if (dim > 4096) {
      // Match the API's `MAX_VECTOR_DIMENSION` from collection-ddl.ts.
      throw new Error(`Vector dimension ${dim} on column '${colName}' exceeds amba's cap of 4096.`);
    }
    out.dimension = dim;
    if (slot4 !== undefined) {
      if (slot4 !== 'nullable') {
        throw new Error(
          `Invalid trailing token '${slot4}' on vector column '${colName}'. Only 'nullable' is allowed after the dimension.`,
        );
      }
      out.nullable = true;
    }
    return out;
  }

  // Non-vector: slot 3 is either `nullable` OR an `fk(...)` directive.
  if (slot3 === 'nullable') {
    out.nullable = true;
    if (slot4 !== undefined) {
      throw new Error(
        `Invalid trailing token '${slot4}' on column '${colName}'. 'nullable' must be the last segment for plain fields.`,
      );
    }
    return out;
  }

  if (slot3.startsWith('fk(') && slot3.endsWith(')')) {
    out.references = parseFkSpec(slot3.slice(3, -1).replace(/\|/g, ':'));
    if (slot4 !== undefined) {
      if (slot4 !== 'nullable') {
        throw new Error(
          `Invalid trailing token '${slot4}' on column '${colName}'. Only 'nullable' is allowed after fk(...).`,
        );
      }
      out.nullable = true;
    }
    return out;
  }

  throw new Error(
    `Invalid third segment '${slot3}' on column '${colName}'. Expected 'nullable', fk(...), or — for vector columns — a positive integer dimension.`,
  );
}

/**
 * Parse the `fk(...)` body into the API's `references` shape.
 * Supported inner grammars:
 *   - `<table>` → `{ table }` (FK to `<table>(id)`, no ON DELETE clause)
 *   - `<table>.<column>` → `{ table, column }`
 *   - `<table>:<onDelete>` → `{ table, onDelete }`
 *   - `<table>.<column>:<onDelete>` → `{ table, column, onDelete }`
 *
 * `onDelete` accepts case-insensitive `cascade | restrict | set_null | no_action`
 * (and the `set null` / `no action` SQL spellings) — translated to the
 * canonical uppercased form the API expects.
 */
function parseFkSpec(inner: string): NonNullable<CollectionColumn['references']> {
  const [tablePart, onDelete] = inner.includes(':')
    ? (inner.split(':') as [string, string])
    : [inner, undefined];
  const trimmedTable = tablePart.trim();
  if (trimmedTable.length === 0) {
    throw new Error(`Invalid fk(...) — table name is required.`);
  }
  const dotIdx = trimmedTable.indexOf('.');
  let table: string;
  let column: string | undefined;
  if (dotIdx === -1) {
    table = trimmedTable;
  } else {
    table = trimmedTable.slice(0, dotIdx);
    column = trimmedTable.slice(dotIdx + 1);
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`Invalid fk table name '${table}'.`);
  }
  if (column !== undefined && !/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`Invalid fk column name '${column}'.`);
  }

  const out: NonNullable<CollectionColumn['references']> = { table };
  if (column !== undefined) out.column = column;
  if (onDelete !== undefined) {
    out.onDelete = normalizeOnDelete(onDelete);
  }
  return out;
}

function normalizeOnDelete(raw: string): NonNullable<CollectionColumn['references']>['onDelete'] {
  const lc = raw.trim().toLowerCase().replace(/_/g, ' ');
  switch (lc) {
    case 'cascade':
      return 'CASCADE';
    case 'restrict':
      return 'RESTRICT';
    case 'set null':
      return 'SET NULL';
    case 'no action':
      return 'NO ACTION';
    default:
      throw new Error(
        `Invalid onDelete '${raw}' in fk(...). Supported: cascade | restrict | set_null | no_action.`,
      );
  }
}

/**
 * Parse an index spec into the wire shape data's API expects.
 *
 * Input syntax (CLI-friendly): `"col1 [asc|desc], col2 [asc|desc]"`.
 * Wire shape (per data's contract): `{ columns: ['col1 desc', 'col2 asc'] }` —
 * direction is embedded in each column string and parsed by the DDL emit.
 *
 * Bare column names (no direction) are passed through verbatim; the
 * default sort direction is the DDL emit's responsibility.
 */
function parseIndexSpec(spec: string): CollectionIndex {
  const cols: string[] = [];
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error(`Invalid index spec '${spec}'.`);
    }
    // Validate the column name + optional direction.
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(asc|desc))?$/i.exec(trimmed);
    if (!m) {
      throw new Error(`Invalid index column '${trimmed}'. Expected '<col>' or '<col> asc|desc'.`);
    }
    const colName = m[1]!;
    const direction = m[2]?.toLowerCase();
    cols.push(direction ? `${colName} ${direction}` : colName);
  }
  return { columns: cols };
}
