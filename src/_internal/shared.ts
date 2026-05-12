/**
 * Constants, types, and validators inlined from the shared package so the
 * CLI ships as a self-contained binary without runtime workspace deps.
 */

// ─── Constants ────────────────────────────────────────────────────────

export const API_VERSION = 'v1';
export const DEFAULT_API_URL = 'https://api.amba.dev';
export const CONSOLE_URL = 'https://app.amba.dev';

// ─── API envelope types ───────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
}

export interface ApiListResponse<T> {
  data: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ─── Reserved collection-name policy ──────────────────────────────────
//
// Customer-defined collection names cannot collide with platform tenant
// tables, Postgres internals, or the reserved namespace used for amba's
// own collections. Append-only at runtime — every existing customer
// collection assumes its name doesn't match any prefix.

const RESERVED_COLLECTION_PREFIXES = [
  '_amba_',
  'pg_',
  'coll_amba_',
  'events_',
  'media_',
  'streak_',
  'xp_',
  'achievement_',
  'challenge_',
  'currency_',
  'feed_',
  'friend_',
  'group_',
  'inventory_',
  'leaderboard_',
  'league_',
  'messaging_',
  'moderation_',
  'onboarding_',
  'referral_',
  'review_',
  'role_',
  'session_',
  'store_',
] as const;

const RESERVED_COLLECTION_EXACT_NAMES = [
  'app_users',
  'magic_link_tokens',
  'remote_config',
  'remote_configs',
  'engagement_events',
  'schema_migrations',
  'segment_memberships',
  'segments',
  'config_versions',
  'push_tokens',
  'push_campaigns',
  'push_deliveries',
  'user_streaks',
  'streak_definitions',
  'streak_events',
  'user_entitlements',
  'app_user_sessions',
  'content_items',
  'content_libraries',
  'content_schedules',
] as const;

const VALID_COLLECTION_NAME_RE = /^[a-z][a-z0-9_]*$/;
const MAX_COLLECTION_NAME_LENGTH = 50;

/** Return why a collection name is reserved/invalid, or `null` if acceptable. */
export function getReservationReason(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) {
    return 'Collection name must be a non-empty string';
  }
  if (name.length > MAX_COLLECTION_NAME_LENGTH) {
    return `Collection name must be at most ${MAX_COLLECTION_NAME_LENGTH} characters`;
  }
  for (const prefix of RESERVED_COLLECTION_PREFIXES) {
    if (name.startsWith(prefix)) {
      return `Collection name starts with reserved prefix "${prefix}"`;
    }
  }
  for (const exact of RESERVED_COLLECTION_EXACT_NAMES) {
    if (name === exact) {
      return `Collection name "${exact}" is reserved by an existing platform tenant table`;
    }
  }
  if (!VALID_COLLECTION_NAME_RE.test(name)) {
    return 'Collection name must match /^[a-z][a-z0-9_]*$/ (lowercase ASCII, digits, underscore; must start with a letter)';
  }
  return null;
}

// ─── Reserved binding-name policy ─────────────────────────────────────
//
// Customer-supplied secret / binding names cannot collide with platform
// bindings (`AMBA_*`, `EDGE_*`, `STORAGE`, `HYPERDRIVE`, `EDGE_DB_PROXY`).
// Treat the list as append-only at runtime.

const RESERVED_BINDING_PREFIXES = ['AMBA_', 'EDGE_'] as const;
const RESERVED_BINDING_EXACT_NAMES = ['STORAGE', 'HYPERDRIVE', 'EDGE_DB_PROXY'] as const;
const VALID_BINDING_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_BINDING_NAME_LENGTH = 64;

/** Return why a binding name is reserved/invalid, or `null` if acceptable. */
export function getBindingReservationReason(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) {
    return 'Binding name must be a non-empty string';
  }
  if (name.length > MAX_BINDING_NAME_LENGTH) {
    return `Binding name must be at most ${MAX_BINDING_NAME_LENGTH} characters`;
  }
  for (const prefix of RESERVED_BINDING_PREFIXES) {
    if (name.startsWith(prefix)) {
      return `Binding name starts with reserved prefix "${prefix}" (platform namespace)`;
    }
  }
  for (const exact of RESERVED_BINDING_EXACT_NAMES) {
    if (name === exact) {
      return `Binding name "${exact}" is reserved by a platform binding`;
    }
  }
  if (!VALID_BINDING_NAME_RE.test(name)) {
    return 'Binding name must match /^[A-Z][A-Z0-9_]*$/ (uppercase ASCII, digits, underscore; must start with a letter)';
  }
  return null;
}

// ─── Rate-limit config ────────────────────────────────────────────────

export type RateLimitKeyKind = 'user_id' | 'ip';

export interface RateLimitConfig {
  window: string;
  max: number;
  key: RateLimitKeyKind;
}

export const RATE_LIMIT_MAX_CAP = 100_000;
export const RATE_LIMIT_MIN_WINDOW_MS = 1_000;
export const RATE_LIMIT_MAX_WINDOW_MS = 60 * 60 * 1000;

const DURATION_RE = /^(\d+)(s|m|h)$/;
const VALID_KEY_KINDS: ReadonlySet<RateLimitKeyKind> = new Set(['user_id', 'ip']);

/** Convert `60s` / `5m` / `1h` → ms. `null` if unparseable. */
export function parseDurationToMs(window: string): number | null {
  const match = DURATION_RE.exec(window);
  if (!match) return null;
  const n = Number.parseInt(match[1] as string, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (match[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
  }
  return null;
}

/** Validate shape + values. Returns the typed config OR `{ error }`. */
export function validateRateLimitConfig(input: unknown): RateLimitConfig | { error: string } {
  if (input === null || input === undefined) {
    return { error: 'rate_limit config is null or undefined' };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'rate_limit must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj['window'] !== 'string') {
    return { error: 'rate_limit.window must be a duration string (e.g. "60s", "5m", "1h")' };
  }
  const ms = parseDurationToMs(obj['window']);
  if (ms === null) {
    return {
      error: `rate_limit.window "${obj['window']}" is not a valid duration (expected /^\\d+(s|m|h)$/)`,
    };
  }
  if (ms < RATE_LIMIT_MIN_WINDOW_MS) {
    return { error: `rate_limit.window must be at least ${RATE_LIMIT_MIN_WINDOW_MS}ms` };
  }
  if (ms > RATE_LIMIT_MAX_WINDOW_MS) {
    return { error: `rate_limit.window must be at most 1h` };
  }

  if (typeof obj['max'] !== 'number' || !Number.isInteger(obj['max']) || obj['max'] <= 0) {
    return { error: 'rate_limit.max must be a positive integer' };
  }
  if (obj['max'] > RATE_LIMIT_MAX_CAP) {
    return { error: `rate_limit.max must be at most ${RATE_LIMIT_MAX_CAP}` };
  }

  if (typeof obj['key'] !== 'string' || !VALID_KEY_KINDS.has(obj['key'] as RateLimitKeyKind)) {
    return { error: `rate_limit.key must be one of ${[...VALID_KEY_KINDS].join(' | ')}` };
  }

  return {
    window: obj['window'],
    max: obj['max'],
    key: obj['key'] as RateLimitKeyKind,
  };
}
