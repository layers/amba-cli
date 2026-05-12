import { DEFAULT_API_URL, API_VERSION } from './_internal/shared.js';
import type { ApiResponse, ApiListResponse, ApiError } from './_internal/shared.js';
import { resolveBearerToken } from './auth.js';

/**
 * Override the API base via the `AMBA_API_URL` environment variable.
 */
function getApiRoot(): string {
  const override = process.env['AMBA_API_URL'];
  return override && override.length > 0 ? override : DEFAULT_API_URL;
}

function getAdminBaseUrl(): string {
  return `${getApiRoot()}/${API_VERSION}/admin`;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * Make an authenticated request to the Amba admin API.
 *
 * The bearer token comes from `resolveBearerToken()` which honors the
 * `--token <pat>` / `AMBA_PAT` headless-auth path before falling back
 * to stored credentials at `~/.amba/credentials.json`. See
 * `auth.ts:resolveBearerToken` for the full precedence rules.
 *
 * `body` is JSON-serialized when an object/array. Pass a `FormData`
 * instance to send a multipart upload (e.g. `functions deploy` ships
 * the bundled script + metadata blob as multipart) — fetch handles
 * the boundary string + Content-Type itself in that case, so we
 * deliberately do NOT set our default `application/json` header.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await resolveBearerToken();
  const url = `${getAdminBaseUrl()}${path}`;

  const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'amba-cli/0.1.1',
  };
  if (!isMultipart) {
    headers['Content-Type'] = 'application/json';
  }

  // For multipart, pass the FormData verbatim — fetch derives the
  // boundary string + Content-Type. For everything else, JSON-encode
  // unless body is already a string.
  let wireBody: BodyInit | undefined;
  if (body === undefined) {
    wireBody = undefined;
  } else if (isMultipart) {
    wireBody = body as FormData;
  } else {
    wireBody = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: wireBody,
  });

  if (!res.ok) {
    let errorMessage = `API request failed: ${res.status} ${res.statusText}`;
    let errorCode: string | undefined;

    try {
      const errorBody = (await res.json()) as ApiError;
      if (errorBody.error?.message) {
        errorMessage = errorBody.error.message;
        errorCode = errorBody.error.code;
      }
    } catch {
      // Use default error message
    }

    throw new ApiClientError(errorMessage, res.status, errorCode);
  }

  return (await res.json()) as T;
}

/**
 * Generic typed GET against the admin API. Wraps `request` so callers
 * outside this module (e.g. the codegen-engine adapter in
 * `commands/types.ts`) don't need to reach into the private helper.
 *
 * Path is relative to `/admin` — leading slash required (`/projects/X`).
 */
export async function adminGet<T>(path: string): Promise<{ data: T }> {
  // The engine's path-construction prefixes nothing — caller passes the
  // tail. `request<T>` returns the parsed JSON envelope; the engine
  // expects `{ data: T }`, which is the standard shape across our admin
  // routes. Cast aligns the wire shape with the engine's contract.
  return request<{ data: T }>('GET', path);
}

// ─── Project endpoints ───────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  platform: string;
  environment?: string;
  bundle_id?: string | null;
  status?: string;
  created_at?: string;
}

export async function listProjects() {
  return request<ApiListResponse<ProjectSummary>>('GET', '/projects');
}

export async function createProject(input: {
  name: string;
  bundle_id?: string;
  platform?: string;
  /**
   * Project environment. `'development'` flags the row as the developer's
   * personal dev project — used by `amba init` for the dev-project
   * bootstrap. Defaults to `'production'` when omitted.
   */
  environment?: 'development' | 'production';
}) {
  return request<ApiResponse<{ id: string; name: string; platform: string; environment?: string }>>(
    'POST',
    '/projects',
    input,
  );
}

export async function getProject(projectId: string) {
  return request<
    ApiResponse<{
      id: string;
      name: string;
      platform: string;
      environment: string;
      bundle_id: string | null;
      created_at: string;
    }>
  >('GET', `/projects/${projectId}`);
}

export async function deleteProject(projectId: string) {
  return request<ApiResponse<{ id: string; deleted: boolean }>>('DELETE', `/projects/${projectId}`);
}

export async function reprovisionProject(projectId: string) {
  return request<
    ApiResponse<{
      workflowId?: string;
      status?: string;
      message?: string;
    }>
  >('POST', `/projects/${projectId}/reprovision`);
}

export async function getProvisioningStatus(projectId: string) {
  return request<
    ApiResponse<{
      projectId: string;
      status: string;
      workflowId?: string | null;
      errorMessage?: string | null;
    }>
  >('GET', `/projects/${projectId}/provisioning-status`);
}

// ─── API Key endpoints ──────────────────────────────────────────────

export async function createApiKey(
  projectId: string,
  keyType: 'client' | 'server',
  environment: 'development' | 'production',
) {
  return request<
    ApiResponse<{
      id: string;
      key: string;
      key_prefix: string;
      key_type: string;
      environment: string;
    }>
  >('POST', `/projects/${projectId}/api-keys`, { key_type: keyType, environment });
}

// ─── Push endpoints ─────────────────────────────────────────────────

export async function sendTestPush(
  projectId: string,
  input: { title: string; body: string; data?: Record<string, unknown> },
) {
  return request<ApiResponse<{ sent: number; message: string }>>(
    'POST',
    `/projects/${projectId}/push/test`,
    input,
  );
}

// ─── Config endpoints ───────────────────────────────────────────────

export async function listConfig(projectId: string) {
  return request<
    ApiListResponse<{ key: string; value: unknown; value_type: string; description: string | null }>
  >('GET', `/projects/${projectId}/config`);
}

export async function setConfig(
  projectId: string,
  input: { key: string; value: unknown; value_type?: string; description?: string },
) {
  return request<ApiResponse<{ key: string; value: unknown; value_type: string }>>(
    'PUT',
    `/projects/${projectId}/config/${input.key}`,
    input,
  );
}

// ─── Integrations ───────────────────────────────────────────────────

export interface IntegrationSummary {
  provider: string;
  status?: string;
  enabled?: boolean;
  last_verified_at?: string | null;
  [key: string]: unknown;
}

export async function listIntegrations(projectId: string) {
  return request<ApiListResponse<IntegrationSummary>>('GET', `/projects/${projectId}/integrations`);
}

// ─── Users ──────────────────────────────────────────────────────────

export interface AdminUserSummary {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
  created_at?: string;
  [key: string]: unknown;
}

export async function listUsers(projectId: string, query: { limit?: number } = {}) {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return request<ApiListResponse<AdminUserSummary>>(
    'GET',
    `/projects/${projectId}/users${qs ? `?${qs}` : ''}`,
  );
}

export async function getUserEvents(
  projectId: string,
  userId: string,
  query: { limit?: number; since?: string; cursor?: string } = {},
) {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.since) params.set('since', query.since);
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return request<
    ApiListResponse<{
      id?: string;
      event_name: string;
      user_id: string;
      properties?: Record<string, unknown>;
      created_at: string;
    }>
  >('GET', `/projects/${projectId}/users/${userId}/events${qs ? `?${qs}` : ''}`);
}

// ─── Events (project-wide) ─────────────────────────────────────────

export interface AdminEventRow {
  id: string;
  app_user_id: string;
  event_name: string;
  properties: Record<string, unknown>;
  occurred_at: string;
}

export interface AdminEventsPage {
  data: AdminEventRow[];
  next_cursor: string | null;
}

/**
 * Fetch a page of project-wide engagement events. Most-recent-first; when
 * `next_cursor` is non-null the caller should pass it back as `cursor` to
 * continue paging.
 */
export async function listProjectEvents(
  projectId: string,
  query: {
    since?: string;
    until?: string;
    eventName?: string;
    userId?: string;
    limit?: number;
    cursor?: string;
  } = {},
) {
  const params = new URLSearchParams();
  if (query.since) params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.eventName) params.set('event_name', query.eventName);
  if (query.userId) params.set('user_id', query.userId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return request<AdminEventsPage>('GET', `/projects/${projectId}/events${qs ? `?${qs}` : ''}`);
}

export interface EventsCountBucket {
  key: string;
  count: number;
}

export interface EventsCountResponse {
  data: {
    total: number;
    buckets?: EventsCountBucket[];
  };
}

/**
 * Aggregate event counts in a time range. `groupBy` of `event_name` returns
 * the per-event-name bucket list ordered by count desc.
 */
export async function getEventsCount(
  projectId: string,
  query: {
    since: string;
    until?: string;
    eventName?: string;
    groupBy?: 'day' | 'event_name';
  },
) {
  const params = new URLSearchParams();
  params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.eventName) params.set('event_name', query.eventName);
  if (query.groupBy) params.set('group_by', query.groupBy);
  return request<EventsCountResponse>(
    'GET',
    `/projects/${projectId}/events/count?${params.toString()}`,
  );
}

// ─── Streaming exports ────────────────────────────────────────────

/**
 * Stream `/users/export` as line-delimited text. Yields chunks as the
 * server emits them. The endpoint always emits CSV (or NDJSON) so we don't
 * try to parse — callers either tee to disk or split lines themselves.
 */
export async function streamUsersExport(
  projectId: string,
  query: { format?: 'csv' | 'ndjson'; since?: string } = {},
): Promise<Response> {
  const token = await resolveBearerToken();
  const params = new URLSearchParams();
  if (query.format) params.set('format', query.format);
  if (query.since) params.set('since', query.since);
  const qs = params.toString();
  const url = `${getAdminBaseUrl()}/projects/${projectId}/users/export${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'amba-cli/0.1.1',
    },
  });
  if (!res.ok) {
    let errorMessage = `API request failed: ${res.status} ${res.statusText}`;
    let errorCode: string | undefined;
    try {
      const errorBody = (await res.json()) as ApiError;
      if (errorBody.error?.message) {
        errorMessage = errorBody.error.message;
        errorCode = errorBody.error.code;
      }
    } catch {
      // fall through
    }
    throw new ApiClientError(errorMessage, res.status, errorCode);
  }
  return res;
}

// ─── Segments ───────────────────────────────────────────────────────

export async function listSegments(projectId: string) {
  return request<ApiListResponse<{ id: string; name: string; is_active?: boolean }>>(
    'GET',
    `/projects/${projectId}/segments`,
  );
}

export async function createSegment(
  projectId: string,
  input: { name: string; description?: string; rules?: unknown; is_active?: boolean },
) {
  return request<ApiResponse<{ id: string; name: string }>>(
    'POST',
    `/projects/${projectId}/segments`,
    input,
  );
}

// ─── Achievements ───────────────────────────────────────────────────

export async function listAchievements(projectId: string) {
  return request<ApiListResponse<{ id: string; name: string }>>(
    'GET',
    `/projects/${projectId}/achievements`,
  );
}

export async function createAchievement(
  projectId: string,
  input: { code: string; name: string; description?: string; criteria?: unknown; reward?: unknown },
) {
  return request<ApiResponse<{ id: string; name: string }>>(
    'POST',
    `/projects/${projectId}/achievements`,
    input,
  );
}

// ─── Content ────────────────────────────────────────────────────────

export async function listContentLibraries(projectId: string) {
  return request<ApiListResponse<{ id: string; slug: string; name: string }>>(
    'GET',
    `/projects/${projectId}/content/libraries`,
  );
}

export async function createContentLibrary(
  projectId: string,
  input: { slug: string; name: string; description?: string },
) {
  return request<ApiResponse<{ id: string; slug: string }>>(
    'POST',
    `/projects/${projectId}/content/libraries`,
    input,
  );
}

export async function addContentItems(
  projectId: string,
  libraryId: string,
  input: { items: Array<{ key: string; content: unknown; locale?: string }> },
) {
  return request<ApiResponse<{ added: number }>>(
    'POST',
    `/projects/${projectId}/content/libraries/${libraryId}/bulk`,
    input,
  );
}

// ─── XP rules ───────────────────────────────────────────────────────

export async function listXpRules(projectId: string) {
  return request<ApiListResponse<{ id: string; event_name: string; amount: number }>>(
    'GET',
    `/projects/${projectId}/xp`,
  );
}

export async function createXpRule(
  projectId: string,
  input: { event_name: string; amount: number; description?: string },
) {
  return request<ApiResponse<{ id: string; event_name: string; amount: number }>>(
    'POST',
    `/projects/${projectId}/xp`,
    input,
  );
}

// ─── Functions (v2) ────────────────────────────────────────────────
//
// `function_deployments` rows are written via these endpoints — the CLI
// hits the API rather than writing the control DB directly so the API can
// enforce auth + integrity checks (project ownership, name uniqueness,
// active-version flip in one transaction). The actual CF script upload
// goes through `cf-api.ts`; the API call below records that the upload
// succeeded.

export interface FunctionDeploymentRow {
  id: string;
  project_id: string;
  name: string;
  version: number;
  cf_script_name: string;
  cf_dispatch_namespace: string;
  bundle_sha: string;
  status: 'active' | 'superseded' | 'disabled';
  created_at: string;
}

export async function recordFunctionDeployment(
  projectId: string,
  input: {
    name: string;
    cf_script_name: string;
    cf_dispatch_namespace: string;
    bundle_sha: string;
    /**
     * Optional declarative rate-limit. The CLI passes a validated
     * `RateLimitConfig` here; the server persists it on the deployment
     * row. Omitting (or sending `null`) = no rate limit.
     */
    rate_limit?: { window: string; max: number; key: 'user_id' | 'ip' } | null;
  },
) {
  return request<ApiResponse<FunctionDeploymentRow>>(
    'POST',
    `/projects/${projectId}/functions/deployments`,
    input,
  );
}

// ─── Server-side deploy proxy ───────────────────────────────────────────
//
// Wire shape — multipart/form-data:
//   - `script`   Blob   — bundled JS source.
//   - `metadata` JSON-serialized Blob with `{name, rate_limit?}`.
//
// Response: `{ data: <deployment row>, fn_url }`.
//
// The server resolves runtime bindings and uploads the script to the
// underlying platform; the customer never sees the infrastructure.

export interface DeployFunctionResult {
  data: FunctionDeploymentRow;
  /** `https://<project_slug>.fn.amba.host/<name>` — the live invocation URL. */
  fn_url: string;
}

export async function deployFunctionViaApi(
  projectId: string,
  input: {
    /** Function name (matches `/^[a-z][a-z0-9_-]*$/`). */
    name: string;
    /** Bundled JS — single-file ESM entry. Server-enforced 10 MB cap. */
    bundleCode: string;
    /** Optional rate-limit. Validated server-side too. */
    rate_limit?: { window: string; max: number; key: 'user_id' | 'ip' } | null;
  },
) {
  const fd = new FormData();
  fd.set(
    'script',
    new Blob([input.bundleCode], { type: 'application/javascript+module' }),
    `${input.name}.js`,
  );
  // The metadata field is a JSON Blob (per services' route; treats
  // either-string-or-Blob, but Blob preserves Content-Type → easier
  // server-side parse).
  const metadata = {
    name: input.name,
    ...(input.rate_limit !== undefined ? { rate_limit: input.rate_limit } : {}),
  };
  fd.set(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    'metadata.json',
  );

  return request<DeployFunctionResult>('POST', `/projects/${projectId}/functions/deploy`, fd);
}

export async function listFunctionDeployments(
  projectId: string,
  options: { activeOnly?: boolean } = {},
) {
  const qs = options.activeOnly ? '?active=1' : '';
  return request<ApiListResponse<FunctionDeploymentRow>>(
    'GET',
    `/projects/${projectId}/functions/deployments${qs}`,
  );
}

export interface FunctionDeployContext {
  /** Dispatch namespace for the script PUT (e.g. `amba_tenant_functions`). */
  dispatch_namespace: string;
  /** Project slug for `https://{slug}.fn.amba.host/{name}` URL rendering. */
  project_slug: string;
  /**
   * R2 bucket name for the project — shared default OR dedicated tier
   * NULL when storage isn't yet provisioned for the project; deploy
   * step skips the storage binding in that case.
   */
  r2_bucket_name: string | null;
  /**
   * Cloudflare Hyperdrive config id. NULL until storage provisioning
   * completes; deploy step skips the Hyperdrive binding when null and
   * `ctx.collections` returns `tenant_unavailable` until the column is
   * populated.
   */
  cf_hyperdrive_config_id: string | null;
}

export async function getFunctionDispatchNamespace(projectId: string) {
  return request<ApiResponse<FunctionDeployContext>>(
    'GET',
    `/projects/${projectId}/functions/namespace`,
  );
}

// ─── Per-project internal credentials ──────────────────────────────────
//
// Deploy fetches plaintexts here at deploy time and binds them as
// `secret_text` entries on the deployed script. Authority: developer
// Bearer + project ownership; URL is the only project identifier.

export interface InternalCredentialsResponse {
  internal_token: string;
  header_signing_secret: string;
  /** First 4 chars of the random portion — for log correlation, not auth. */
  internal_token_fingerprint: string;
  /** Same shape as above — for log correlation. */
  header_signing_secret_fingerprint: string;
}

export async function fetchInternalCredentials(projectId: string) {
  return request<ApiResponse<InternalCredentialsResponse>>(
    'GET',
    `/projects/${projectId}/internal-credentials`,
  );
}

export async function disableFunctionDeployment(projectId: string, deploymentId: string) {
  return request<ApiResponse<{ id: string; status: string }>>(
    'POST',
    `/projects/${projectId}/functions/deployments/${deploymentId}/disable`,
  );
}

export async function scheduleFunction(
  projectId: string,
  input: { name: string; cron: string; timezone?: string },
) {
  return request<ApiResponse<{ schedule_id: string }>>(
    'POST',
    `/projects/${projectId}/functions/schedules`,
    input,
  );
}

// ─── Functions logs ────────────────────────────────────────────────

export interface FunctionLogEvent {
  /** Logpush row — see `r2-log-reader.ts:LogpushTraceEvent`. Field-shape stable. */
  Event?: { Timestamp?: string };
  ScriptName?: string;
  Outcome?: string;
  Logs?: Array<{ Level?: string; Message?: unknown[]; TimestampMs?: number }>;
  Exceptions?: Array<{ Name?: string; Message?: string; TimestampMs?: number }>;
  EventTimestampMs?: number;
}

export interface FunctionLogsResponse {
  events: FunctionLogEvent[];
  truncated: boolean;
  since: string;
  until: string;
}

export async function getFunctionLogs(
  projectId: string,
  functionName: string,
  options: { since?: string; until?: string; limit?: number } = {},
) {
  const params = new URLSearchParams();
  if (options.since) params.set('since', options.since);
  if (options.until) params.set('until', options.until);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const qs = params.toString();
  return request<ApiResponse<FunctionLogsResponse>>(
    'GET',
    `/projects/${projectId}/functions/${functionName}/logs${qs ? `?${qs}` : ''}`,
  );
}

// ─── Queues ────────────────────────────────────────────────────────

export interface QueueBinding {
  queue_name: string;
  function_name: string;
  status: 'active' | 'paused';
  created_at: string;
  updated_at: string;
}

export async function upsertQueueBinding(
  projectId: string,
  input: { queue_name: string; function_name: string; status?: 'active' | 'paused' },
) {
  return request<ApiResponse<QueueBinding & { id: string }>>(
    'PUT',
    `/projects/${projectId}/queue/bindings`,
    input,
  );
}

export async function listQueueBindings(projectId: string) {
  return request<ApiListResponse<QueueBinding>>('GET', `/projects/${projectId}/queue/bindings`);
}

export async function deleteQueueBinding(projectId: string, queueName: string) {
  return request<ApiResponse<{ queue_name: string; deleted: boolean }>>(
    'DELETE',
    `/projects/${projectId}/queue/bindings/${queueName}?confirm=${encodeURIComponent(queueName)}`,
  );
}

// ─── Secret sync status (low-level) ────────────────────────────────
//
// Returns the pending-sync rows for a project. Customer-facing secret
// management goes through the API-proxy helpers further down.

export interface SecretSyncPendingRow {
  id: string;
  project_id: string;
  function_name: string | null;
  secret_name: string;
  expected_version: number;
  status: 'pending' | 'syncing' | 'sync_failed_retrying' | 'synced';
  last_error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export async function registerSecretSync(
  projectId: string,
  input: {
    function_name: string;
    secret_name: string;
    expected_version: number;
  },
) {
  return request<ApiResponse<SecretSyncPendingRow>>(
    'POST',
    `/projects/${projectId}/secrets/sync`,
    input,
  );
}

export async function listSecretSyncStatus(projectId: string) {
  return request<ApiListResponse<SecretSyncPendingRow>>(
    'GET',
    `/projects/${projectId}/secrets/sync`,
  );
}

// ─── Secrets API-proxy ──────────────────────────────────────────────────
//
// Customers POST plaintext to the platform API; the server stores it
// canonically and propagates the value to the deployed Worker's secret
// binding. Reserved-binding rejection is enforced server-side so the
// API is the single source of truth for the reserved-name list.

export interface SetSecretResultRow {
  /** Secret name as set by the customer. */
  name: string;
  /** Function name the secret binds to. */
  function: string;
  /** Secret store version number (1, 2, 3, ...). */
  version: number;
  /** Backend version resource path — exposed for ops debugging. */
  version_path: string;
  /** `'pending'` until the secret sync completes. */
  sync_status: 'pending' | 'syncing' | 'sync_failed_retrying' | 'synced';
  created_at: string;
}

export async function setSecretViaApi(
  projectId: string,
  input: {
    /** Uppercase identifier (`/^[A-Z][A-Z0-9_]{0,62}$/`). */
    name: string;
    /** Plaintext secret value. <=64KiB. */
    value: string;
    /** Function name the secret binds to. v1 has no project-wide secrets. */
    function: string;
  },
) {
  return request<ApiResponse<SetSecretResultRow>>('POST', `/projects/${projectId}/secrets`, input);
}

export interface ListSecretsRow {
  /** Function name the secret binds to. */
  function: string;
  /** Secret name. */
  name: string;
  /** Latest secret-store version number. */
  version: number;
  sync_status: 'pending' | 'syncing' | 'sync_failed_retrying' | 'synced';
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export async function listSecretsViaApi(projectId: string) {
  return request<ApiListResponse<ListSecretsRow>>('GET', `/projects/${projectId}/secrets`);
}

export async function deleteSecretViaApi(
  projectId: string,
  name: string,
  options: { function: string },
) {
  // Secret name is path-positional; function scope is `?function=<fn>`.
  // URL-encode both to keep curl-equivalence safe.
  const qs = new URLSearchParams({ function: options.function });
  return request<ApiResponse<{ name: string; function: string; deleted: true }>>(
    'DELETE',
    `/projects/${projectId}/secrets/${encodeURIComponent(name)}?${qs.toString()}`,
  );
}

// ─── Collections ──────────────────────────────────────────────────
//
// Vocabulary: `columns` (not `fields`) and the postgres-aligned type
// names (`integer`, not `int`) to match `information_schema.data_type`
// and keep the codegen path consistent.

/** Closed set of column types the server accepts. */
export type CollectionColumnType =
  | 'uuid'
  | 'text'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'boolean'
  | 'timestamptz'
  | 'date'
  | 'jsonb'
  // pgvector. Mandatory `dimension` field when this type is selected.
  // Validated 1..4096 server-side.
  | 'vector';

export interface CollectionColumn {
  name: string;
  type: CollectionColumnType;
  nullable?: boolean;
  references?: {
    table: string;
    column?: string;
    onDelete?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION';
  };
  /**
   * Required when `type === 'vector'`. The pgvector dimension
   * (`vector(N)`). Common values: 384, 768, 1536, 3072.
   */
  dimension?: number;
}

export interface CollectionIndex {
  /** Optional explicit name; auto-derived from column list if omitted. */
  name?: string;
  /** Each entry is `<col>` or `<col> asc|desc`. Direction is parsed by the DDL emit. */
  columns: string[];
  unique?: boolean;
}

export interface CollectionDefinition {
  name: string;
  columns: CollectionColumn[];
  indexes?: CollectionIndex[];
}

/** Create-collection response from `POST /admin/projects/:p/collections`. */
export interface CreateCollectionResult {
  name: string;
  version: number;
  workflow_id: string;
  run_id: string;
  status: 'applied';
}

export async function createCollection(projectId: string, input: CollectionDefinition) {
  return request<ApiResponse<CreateCollectionResult>>(
    'POST',
    `/projects/${projectId}/collections`,
    input,
  );
}

export interface CollectionListItem {
  name: string;
  created_at: string;
}

export async function listCollections(
  projectId: string,
  options: { limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const qs = params.toString();
  return request<ApiListResponse<CollectionListItem>>(
    'GET',
    `/projects/${projectId}/collections${qs ? `?${qs}` : ''}`,
  );
}

export interface CollectionDescribeResult {
  name: string;
  columns: CollectionColumn[];
  indexes: CollectionIndex[];
  latest_migration: { version: number; applied_at: string } | null;
}

export async function describeCollection(projectId: string, name: string) {
  return request<ApiResponse<CollectionDescribeResult>>(
    'GET',
    `/projects/${projectId}/collections/${name}`,
  );
}

/**
 * Single-op PATCH per data's contract — one of `add_column`, `add_index`,
 * or `drop_column` per call. The saga writes one registry row per intent
 * so the operator audit trail stays one-to-one with developer actions.
 *
 * `drop_column` requires a `?confirm=<column-name>` query param to guard
 * against typos — same accident-protection pattern as `dropCollection`.
 */
export type AlterCollectionPatch =
  | { add_column: CollectionColumn }
  | { add_index: CollectionIndex }
  | { drop_column: string };

export interface AlterCollectionResult {
  name: string;
  version: number;
  workflow_id: string;
  run_id: string;
  status: 'applied';
}

export async function alterCollection(
  projectId: string,
  name: string,
  patch: AlterCollectionPatch,
  options: { confirm?: string } = {},
) {
  const path = `/projects/${projectId}/collections/${name}${
    options.confirm ? `?confirm=${encodeURIComponent(options.confirm)}` : ''
  }`;
  return request<ApiResponse<AlterCollectionResult>>('PATCH', path, patch);
}

/**
 * Drop a collection. Requires `confirm` matching the collection name —
 * data's safety guard against typos. CLI surfaces this as `--confirm <name>`.
 */
export async function dropCollection(projectId: string, name: string, confirm: string) {
  return request<ApiResponse<{ name: string; deleted: boolean; version: number }>>(
    'DELETE',
    `/projects/${projectId}/collections/${name}?confirm=${encodeURIComponent(confirm)}`,
  );
}

// ─── AI providers ─────────────────────────────────────────────────────
//
// Per-project API-key registration for the AI gateway. Plaintext is
// stored canonically by the platform; only an `api_key_preview`
// (first-6 + last-4) is returned on register so the CLI can echo back a
// recognizable cue without printing the key.

export type AiProviderName = 'anthropic' | 'openai';

export interface AiProviderRow {
  name: AiProviderName;
  /** Canonical secret name in the secret store. NULL only mid-rotation. */
  api_key_secret_name: string | null;
  /** Preview cue printed to the CLI on register; NOT a real partial key. */
  api_key_preview?: string;
  created_at?: string;
  updated_at?: string;
}

export async function registerAiProvider(
  projectId: string,
  input: { name: AiProviderName; api_key: string },
) {
  return request<ApiResponse<AiProviderRow>>('POST', `/projects/${projectId}/ai/providers`, input);
}

export async function listAiProviders(projectId: string) {
  return request<ApiListResponse<AiProviderRow>>('GET', `/projects/${projectId}/ai/providers`);
}

export async function deleteAiProvider(projectId: string, name: AiProviderName) {
  return request<ApiResponse<{ name: AiProviderName; deleted: true }>>(
    'DELETE',
    `/projects/${projectId}/ai/providers/${encodeURIComponent(name)}`,
  );
}

// ─── Sites ────────────────────────────────────────────────────────────
//
// Static-site control plane. Site rows and custom-hostname rows are
// persisted via these admin endpoints; static deployments and cert
// provisioning go through the deploy-proxy + domain-proxy helpers
// below.

export interface SiteRow {
  id: string;
  project_id: string;
  name: string;
  cf_pages_project_name: string;
  status: 'active' | 'disabled' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface SiteDomainRow {
  id: string;
  site_id: string;
  hostname: string;
  cf_hostname_id: string | null;
  cert_status:
    | 'pending_validation'
    | 'pending_issuance'
    | 'pending_deployment'
    | 'active'
    | 'error';
  created_at: string;
  updated_at: string;
}

export async function createSite(projectId: string, input: { name: string }) {
  return request<ApiResponse<SiteRow>>('POST', `/projects/${projectId}/sites`, input);
}

export async function listSites(projectId: string) {
  return request<ApiListResponse<SiteRow>>('GET', `/projects/${projectId}/sites`);
}

export async function describeSite(projectId: string, name: string) {
  return request<ApiResponse<SiteRow & { domains: SiteDomainRow[] }>>(
    'GET',
    `/projects/${projectId}/sites/${encodeURIComponent(name)}`,
  );
}

// ─── Sites deploy proxy ─────────────────────────────────────────────────
//
// Customers POST a multipart of files keyed by relative path here; the
// platform API forwards them to the CDN and returns a canonical URL on
// `*.app.amba.host`.
//
// Wire shape — multipart/form-data:
//   - `<path>`:    File Blob, one per file. Filename in Content-
//                  Disposition is the relative path (e.g. `index.html`,
//                  `assets/main.js`). 25 MiB per-file cap.
//   - `branch`:    Optional string field — defaults to `'main'`.
//   - `manifest`:  Required JSON Blob `{path → sha256-hex}`.

export interface DeploySiteResult {
  /** Deployment uuid. */
  deployment_id: string;
  site_name: string;
  branch: string;
  /** Customer-facing canonical URL (`https://{slug}-{site}.app.amba.host`). */
  url: string;
  /** Underlying CDN preview URL — exposed for ops. */
  preview_url: string;
  deployed_at: string;
  status: 'queued' | 'building' | 'success' | 'failure';
}

export async function deploySiteViaApi(projectId: string, siteName: string, body: FormData) {
  return request<ApiResponse<DeploySiteResult>>(
    'POST',
    `/projects/${projectId}/sites/${encodeURIComponent(siteName)}/deployments`,
    body,
  );
}

export async function updateSite(
  projectId: string,
  name: string,
  patch: { status: 'active' | 'disabled' },
) {
  return request<ApiResponse<SiteRow>>(
    'PATCH',
    `/projects/${projectId}/sites/${encodeURIComponent(name)}`,
    patch,
  );
}

export async function archiveSite(projectId: string, name: string, confirm: string) {
  return request<ApiResponse<SiteRow>>(
    'DELETE',
    `/projects/${projectId}/sites/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`,
  );
}

// ─── Admin proxy helpers ────────────────────────────────────────────────
//
// All site/function management calls route through the platform API;
// customers never need direct CDN credentials.

/** Cascade summary returned by site/function delete proxies. */
export interface DeleteCascadeSummary {
  domains_removed?: number;
  cf_pages_project_deleted?: boolean;
  cf_dispatch_script_deleted?: boolean;
  function_deployments_marked_disabled?: number;
}

/**
 * Add a custom domain to a site. The server-side proxy registers the
 * custom hostname, persists the resulting `cf_hostname_id`, and returns
 * the CNAME target the customer should point their DNS at.
 */
export async function addSiteDomainViaApi(projectId: string, siteName: string, hostname: string) {
  return request<
    ApiResponse<{
      hostname: string;
      cf_hostname_id: string;
      cert_status: SiteDomainRow['cert_status'];
      dns_target: string;
      created_at: string;
    }>
  >('POST', `/projects/${projectId}/sites/${encodeURIComponent(siteName)}/domains`, { hostname });
}

/**
 * Remove a custom domain from a site. Idempotent — re-running on an
 * already-removed hostname returns 200 with `deleted: true`. Backend
 * 404s are treated as success at the proxy layer.
 */
export async function removeSiteDomainViaApi(
  projectId: string,
  siteName: string,
  hostname: string,
) {
  return request<ApiResponse<{ hostname: string; deleted: true }>>(
    'DELETE',
    `/projects/${projectId}/sites/${encodeURIComponent(siteName)}/domains/${encodeURIComponent(hostname)}`,
  );
}

/**
 * Roll a live CF Pages deployment back to a prior `deployment_id`. CF's
 * rollback creates a NEW deployment that serves the prior bundle (git-
 * revert semantics, not git-reset), so the response shape mirrors
 * `DeploySiteResult` and the new `deployment_id` is what's now live.
 */
export async function rollbackSiteViaApi(
  projectId: string,
  siteName: string,
  deploymentId: string,
) {
  return request<ApiResponse<DeploySiteResult>>(
    'POST',
    `/projects/${projectId}/sites/${encodeURIComponent(siteName)}/rollback`,
    { deployment_id: deploymentId },
  );
}

/**
 * Delete a site entirely. Cascade: removes attached custom hostnames,
 * tears down the CDN project, and soft-deletes the site row. Partial
 * failures surface as `503 CASCADE_PARTIAL_FAILURE` with the `cascade`
 * field telling the CLI which steps completed.
 */
export async function deleteSiteViaApi(
  projectId: string,
  siteName: string,
  options: { confirm: string },
) {
  return request<
    ApiResponse<{
      name: string;
      deleted: true;
      cascade: DeleteCascadeSummary;
    }>
  >(
    'DELETE',
    `/projects/${projectId}/sites/${encodeURIComponent(siteName)}?confirm=${encodeURIComponent(options.confirm)}`,
  );
}

/**
 * Delete a function entirely. Cascade: removes the deployed script
 * (backend 404 treated as success), then marks every historical
 * deployment row as `status='disabled'` to keep history intact for
 * audit. Customer Workers stop responding immediately on cascade
 * step 1.
 */
export async function deleteFunctionViaApi(
  projectId: string,
  functionName: string,
  options: { confirm: string },
) {
  return request<
    ApiResponse<{
      name: string;
      deleted: true;
      cascade: DeleteCascadeSummary;
    }>
  >(
    'DELETE',
    `/projects/${projectId}/functions/${encodeURIComponent(functionName)}?confirm=${encodeURIComponent(options.confirm)}`,
  );
}

export async function attachSiteDomain(
  projectId: string,
  siteName: string,
  input: { hostname: string; cf_hostname_id?: string },
) {
  return request<ApiResponse<SiteDomainRow>>(
    'POST',
    `/projects/${projectId}/sites/${encodeURIComponent(siteName)}/domains`,
    input,
  );
}

export async function listSiteDomains(projectId: string, siteName: string) {
  return request<ApiListResponse<SiteDomainRow>>(
    'GET',
    `/projects/${projectId}/sites/${encodeURIComponent(siteName)}/domains`,
  );
}

export async function updateSiteDomain(
  projectId: string,
  siteName: string,
  hostname: string,
  patch: { cert_status: SiteDomainRow['cert_status']; cf_hostname_id?: string },
) {
  return request<ApiResponse<SiteDomainRow>>(
    'PATCH',
    `/projects/${projectId}/sites/${encodeURIComponent(siteName)}/domains/${encodeURIComponent(hostname)}`,
    patch,
  );
}

export async function detachSiteDomain(projectId: string, siteName: string, hostname: string) {
  return request<ApiResponse<{ deleted: boolean }>>(
    'DELETE',
    `/projects/${projectId}/sites/${encodeURIComponent(siteName)}/domains/${encodeURIComponent(hostname)}`,
  );
}

// ─── Status / validation ────────────────────────────────────────────

export async function validateApiKey(apiKey: string) {
  const res = await fetch(`${getApiRoot()}/${API_VERSION}/auth/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'amba-cli/0.1.1',
    },
    body: JSON.stringify({ api_key: apiKey }),
  });

  if (!res.ok) {
    return { valid: false as const, error: `HTTP ${res.status}` };
  }

  const body = (await res.json()) as ApiResponse<{
    valid: boolean;
    project_id: string;
    environment: string;
  }>;
  const { valid: _valid, ...rest } = body.data;
  return { valid: true as const, ...rest };
}
