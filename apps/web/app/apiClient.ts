// Thin `fetch` wrapper for the Muralist persistence API.
//
// Contract lives in docs/plans/persistence-and-auth-backend.md §1 steps 21–24.
// All mutating requests carry cookies (`credentials: "include"` for Better
// Auth) plus the double-submit CSRF header read from the `csrf-token` cookie.
//
// This file is UI-skeleton per §1 step 30: not yet wired into
// PrototypeApp.tsx. The future UI round consumes it.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Tier = "free" | "paid";

export type ProSettings = {
  autoCombineSensitivity?: "conservative" | "balanced" | "aggressive" | "custom";
  residualThreshold?: number;
  mixCoveragePercent?: number;
};

export type LinkedProvider = {
  providerId: string;
  email?: string;
  linkedAt: string;
};

export type Me = {
  tier: Tier;
  effectiveTier: Tier;
  projectLimit: number | null;
  activeProjectCount: number;
  atLimit: boolean;
  overLimit: boolean;
  linkedProviders: LinkedProvider[];
  proSettings: ProSettings;
};

export type ProjectStatus = "active" | "trashed";

export type ProjectTile = {
  id: string;
  name: string;
  /** base64-encoded thumbnail (no data URL prefix). */
  thumbnail: string;
  lastViewedAt: string;
  /** Not currently returned by the list endpoint; reserved for future use. */
  createdAt?: string;
  status: ProjectStatus;
};

export type PaletteColor = {
  id: string;
  hex: string;
  coverage: number;
  classification?: "buy" | "mix" | "absorb";
  /**
   * User-toggled: when true the color is skipped from the estimate and the
   * maquette PDF's swatch table. Persisted server-side via the optional
   * `disabled` field on `paletteColorSchema`.
   */
  disabled?: boolean;
};

export type MergeOperation = {
  id: string;
  sourceIds: string[];
  keeperId: string;
  appliedAt: string;
};

export type PaletteJson = {
  colors: PaletteColor[];
  originalColors?: PaletteColor[];
  merges?: MergeOperation[];
  mixRecipes?: unknown[];
  finishOverrides?: Record<string, string>;
  coatsOverrides?: Record<string, number>;
};

export type ProjectMetadata = {
  notes?: string;
  wallDimensions?: {
    lengthInches?: number;
    heightInches?: number;
  };
};

export type ProjectFull = {
  id: string;
  userId: string;
  name: string;
  palette: PaletteJson;
  /** base64-encoded sanitized image (no data URL prefix). */
  sanitizedImage: string;
  metadata: ProjectMetadata;
  version: number;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  lastViewedAt: string;
  deletedAt?: string;
};

export type CreateProjectPayload = {
  name: string;
  palette: PaletteJson;
  /** base64 sanitized image, no data URL prefix. */
  image: string;
  /** base64 thumbnail, no data URL prefix. */
  thumbnail: string;
  metadata?: ProjectMetadata;
};

export type UpdateMetadataPayload = Partial<{
  name: string;
  notes: string;
  wallDimensions: {
    lengthInches?: number;
    heightInches?: number;
  };
}>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class UnauthenticatedError extends ApiError {
  constructor(body: unknown) {
    super(401, body, "Unauthenticated.");
    this.name = "UnauthenticatedError";
  }
}

export class OverLimitError extends ApiError {
  readonly code: string | undefined;

  constructor(body: unknown) {
    super(403, body, "Over tier limit.");
    this.name = "OverLimitError";
    this.code = extractErrorCode(body);
  }
}

export class VersionConflictError extends ApiError {
  constructor(body: unknown) {
    super(409, body, "Version conflict.");
    this.name = "VersionConflictError";
  }
}

export class PreconditionRequiredError extends ApiError {
  constructor(body: unknown) {
    super(428, body, "Precondition required.");
    this.name = "PreconditionRequiredError";
  }
}

function extractErrorCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const value = (body as { error?: unknown }).error;
    if (typeof value === "string") return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export const DEFAULT_API_BASE_URL = "http://localhost:4000";

function resolveBaseUrl(): string {
  // Next.js inlines NEXT_PUBLIC_* at build time; fall back for non-Next
  // callers (tests, SSR workers).
  const fromEnv =
    typeof process !== "undefined"
      ? process.env?.NEXT_PUBLIC_API_BASE_URL
      : undefined;
  return (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_API_BASE_URL).replace(
    /\/+$/,
    ""
  );
}

/**
 * Reads the `csrf-token` cookie set by `@fastify/csrf-protection`. Returns
 * `null` when the cookie is absent (e.g. guest) or when running outside a
 * browser.
 *
 * Kept for tests and same-origin setups. In prod, the web origin
 * (muraliste.com) cannot read cookies set on the API origin
 * (api.muraliste.com), so the in-memory token returned by
 * `ensureCsrfToken` is the real source of truth.
 */
export function readCsrfToken(documentLike?: { cookie: string }): string | null {
  const doc =
    documentLike ??
    (typeof document !== "undefined"
      ? (document as unknown as { cookie: string })
      : undefined);
  if (!doc) return null;
  const cookies = doc.cookie.split(";");
  for (const entry of cookies) {
    const trimmed = entry.trim();
    if (trimmed.startsWith("csrf-token=")) {
      const value = trimmed.slice("csrf-token=".length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

/**
 * In-memory CSRF token cache. The signed secret lives in an api-origin
 * cookie the browser sends automatically on credentialed fetches; the
 * *token* we must echo in `X-CSRF-Token` comes back in the body of
 * `GET /csrf-token`. document.cookie can't see api-subdomain cookies, so
 * we hold the token in memory instead of re-reading it per request.
 */
let cachedCsrfToken: string | null = null;
let inflightCsrfFetch: Promise<string | null> | null = null;

/** Test hook — reset the in-memory cache. */
export function __resetCsrfTokenCache(): void {
  cachedCsrfToken = null;
  inflightCsrfFetch = null;
}

async function fetchCsrfToken(
  baseUrl: string,
  fetchImpl: typeof fetch
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${baseUrl}/csrf-token`, {
      method: "GET",
      credentials: "include"
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as
      | { token?: unknown }
      | null;
    const token = body && typeof body.token === "string" ? body.token : null;
    return token;
  } catch {
    return null;
  }
}

async function ensureCsrfToken(
  baseUrl: string,
  fetchImpl: typeof fetch,
  forceRefresh = false
): Promise<string | null> {
  if (!forceRefresh && cachedCsrfToken) return cachedCsrfToken;
  if (!inflightCsrfFetch) {
    inflightCsrfFetch = fetchCsrfToken(baseUrl, fetchImpl).then((token) => {
      cachedCsrfToken = token;
      inflightCsrfFetch = null;
      return token;
    });
  }
  return inflightCsrfFetch;
}

export type ApiRequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** For tests / SSR. */
  fetchImpl?: typeof fetch;
  /** For tests. */
  documentLike?: { cookie: string };
  /** For tests / overriding the NEXT_PUBLIC_API_BASE_URL lookup. */
  baseUrl?: string;
  /** Bypass JSON parsing and return the raw Response. */
  rawResponse?: boolean;
};

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function throwForStatus(status: number, body: unknown): never {
  if (status === 401) throw new UnauthenticatedError(body);
  if (status === 403) throw new OverLimitError(body);
  if (status === 409) throw new VersionConflictError(body);
  if (status === 428) throw new PreconditionRequiredError(body);
  throw new ApiError(status, body);
}

function isCsrfError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const maybe = (body as { error?: unknown; code?: unknown }).error;
  const code = typeof maybe === "string" ? maybe : undefined;
  return typeof code === "string" && code.startsWith("FST_CSRF_");
}

export async function apiRequest<T = unknown>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? resolveBaseUrl();
  const isMutating = MUTATING_METHODS.has(method);

  async function buildHeaders(forceRefreshCsrf: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined && !(options.body instanceof Blob) && typeof options.body !== "string") {
      headers["content-type"] = headers["content-type"] ?? "application/json";
    }
    if (isMutating) {
      // When the caller supplies a `documentLike` cookie jar (tests,
      // same-origin setups), prefer the cookie read — it avoids an
      // unmocked `/csrf-token` fetch. In real browsers the web origin
      // can't read api-subdomain cookies, so fall through to the
      // in-memory token seeded by `ensureCsrfToken`.
      let token: string | null | undefined;
      if (options.documentLike) {
        token = readCsrfToken(options.documentLike);
      } else {
        token = await ensureCsrfToken(baseUrl, fetchImpl, forceRefreshCsrf);
        if (!token) token = readCsrfToken();
      }
      if (token) headers["x-csrf-token"] = token;
    }
    return headers;
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof Blob || typeof options.body === "string") {
      body = options.body as BodyInit;
    } else {
      body = JSON.stringify(options.body);
    }
  }

  async function doFetch(forceRefreshCsrf: boolean): Promise<Response> {
    const headers = await buildHeaders(forceRefreshCsrf);
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      credentials: "include",
      headers,
      body
    });
  }

  let response = await doFetch(false);

  // If we get a CSRF failure, the cached token may be stale (server
  // restarted, secret cookie evicted, token rotated). Refresh once and
  // retry before surfacing the error.
  if (isMutating && response.status === 403) {
    const peeked = response.clone();
    const peekedBody = await readBody(peeked);
    if (isCsrfError(peekedBody)) {
      cachedCsrfToken = null;
      response = await doFetch(true);
    }
  }

  if (options.rawResponse) {
    if (!response.ok) {
      const errBody = await readBody(response);
      throwForStatus(response.status, errBody);
    }
    return response as unknown as T;
  }

  const parsed = await readBody(response);
  if (!response.ok) {
    throwForStatus(response.status, parsed);
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Typed endpoint wrappers
// ---------------------------------------------------------------------------

export function getMe(options: ApiRequestOptions = {}): Promise<Me> {
  return apiRequest<Me>("/me", options);
}

export async function updateProSettings(
  patch: ProSettings,
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>("/me/pro-settings", {
    ...options,
    method: "PATCH",
    body: patch
  });
}

export async function listProjects(
  status?: ProjectStatus,
  options: ApiRequestOptions = {}
): Promise<ProjectTile[]> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  // Server returns `{ projects: [...] }`; unwrap so callers get a plain array.
  const body = await apiRequest<{ projects: ProjectTile[] } | ProjectTile[]>(
    `/projects${suffix}`,
    options
  );
  if (Array.isArray(body)) return body;
  return body?.projects ?? [];
}

export function getProject(
  id: string,
  options: ApiRequestOptions = {}
): Promise<ProjectFull> {
  return apiRequest<ProjectFull>(`/projects/${encodeURIComponent(id)}`, options);
}

export function createProject(
  payload: CreateProjectPayload,
  options: ApiRequestOptions = {}
): Promise<ProjectFull> {
  return apiRequest<ProjectFull>("/projects", {
    ...options,
    method: "POST",
    body: payload
  });
}

export async function updatePalette(
  id: string,
  palette: PaletteJson,
  version: number,
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>(`/projects/${encodeURIComponent(id)}/palette`, {
    ...options,
    method: "PATCH",
    body: { palette },
    headers: {
      ...(options.headers ?? {}),
      "if-match": String(version)
    }
  });
}

export async function updateImage(
  id: string,
  base64: string,
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>(`/projects/${encodeURIComponent(id)}/image`, {
    ...options,
    method: "PATCH",
    body: { image: base64 }
  });
}

export async function updateThumbnail(
  id: string,
  base64: string,
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>(`/projects/${encodeURIComponent(id)}/thumbnail`, {
    ...options,
    method: "PATCH",
    body: { thumbnail: base64 }
  });
}

export async function updateMetadata(
  id: string,
  patch: UpdateMetadataPayload,
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>(`/projects/${encodeURIComponent(id)}/metadata`, {
    ...options,
    method: "PATCH",
    body: patch
  });
}

export async function deleteProject(
  id: string,
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>(`/projects/${encodeURIComponent(id)}`, {
    ...options,
    method: "DELETE"
  });
}

export async function restoreProject(
  id: string,
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>(`/projects/${encodeURIComponent(id)}/restore`, {
    ...options,
    method: "POST"
  });
}

export async function markViewed(
  id: string,
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>(`/projects/${encodeURIComponent(id)}/viewed`, {
    ...options,
    method: "POST"
  });
}

export async function exportAllData(
  options: ApiRequestOptions = {}
): Promise<Blob> {
  const response = await apiRequest<Response>("/export", {
    ...options,
    rawResponse: true
  });
  return response.blob();
}

export async function deleteAccount(
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>("/account", {
    ...options,
    method: "DELETE"
  });
}

export async function cancelAccountDeletion(
  options: ApiRequestOptions = {}
): Promise<void> {
  await apiRequest<void>("/account/delete-cancel", {
    ...options,
    method: "POST"
  });
}

// ---------------------------------------------------------------------------
// Better Auth wrappers
//
// Better Auth's routes are mounted at `/api/auth/*` on the API host — distinct
// from the product endpoints above (`/me`, `/projects`, etc). The sign-in /
// sign-out helpers go through the same `apiRequest` so they pick up
// `credentials: "include"` for cookie flow.
// ---------------------------------------------------------------------------

export type SocialProvider =
  | "google"
  | "apple"
  | "facebook"
  | "adobe";

export type SignInSocialResponse = {
  /** Provider authorization URL the browser must navigate to. */
  url: string;
  /** Better Auth signals whether it expects the client to redirect. */
  redirect?: boolean;
};

/**
 * POST /api/auth/sign-in/social — kicks off the provider OAuth dance.
 * Returns the provider authorization URL; the caller must navigate the browser
 * to it (e.g. `window.location.assign(response.url)`).
 */
export function signInSocial(
  payload: { provider: SocialProvider; callbackURL: string },
  options: ApiRequestOptions = {}
): Promise<SignInSocialResponse> {
  return apiRequest<SignInSocialResponse>("/api/auth/sign-in/social", {
    ...options,
    method: "POST",
    body: payload
  });
}

/**
 * POST /api/auth/sign-out — clears the Better Auth session cookie.
 */
export async function signOut(options: ApiRequestOptions = {}): Promise<void> {
  // Better Auth's sign-out route runs through Fastify's JSON body parser,
  // which rejects empty bodies with FST_ERR_CTP_EMPTY_JSON_BODY. Send an
  // empty object so the parser succeeds; the endpoint ignores the payload.
  await apiRequest<void>("/api/auth/sign-out", {
    ...options,
    method: "POST",
    body: {}
  });
}
