import type { FastifyInstance } from "fastify";
import type { InjectOptions, Response as InjectResponse } from "light-my-request";

/**
 * Seed a CSRF secret cookie + matching token for a test session.
 * Calls `GET /csrf-token`, parses the Set-Cookie header for the secret, and
 * returns the pair so callers can compose `headers` + `cookies` for
 * `app.inject`.
 */
export async function seedCsrf(app: FastifyInstance): Promise<{
  cookie: string;
  token: string;
}> {
  const response = await app.inject({ method: "GET", url: "/csrf-token" });
  if (response.statusCode !== 200) {
    throw new Error(
      `seedCsrf: GET /csrf-token returned ${response.statusCode}: ${response.body}`
    );
  }
  const token = (response.json() as { token: string }).token;
  const csrfCookie = response.cookies.find((c) => c.name === "csrf-token");
  if (!csrfCookie) {
    throw new Error("seedCsrf: no csrf-token cookie set by GET /csrf-token");
  }
  return { cookie: csrfCookie.value, token };
}

/**
 * Build a `{ headers, cookies }` fragment a mutating `app.inject({...})` call
 * can spread into its options. Saves each test from having to reassemble the
 * CSRF pieces.
 */
export async function mutatingInjectOpts(
  app: FastifyInstance
): Promise<{
  headers: Record<string, string>;
  cookies: Record<string, string>;
}> {
  const { cookie, token } = await seedCsrf(app);
  return {
    headers: { "x-csrf-token": token },
    cookies: { "csrf-token": cookie }
  };
}

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * `app.inject` wrapper that auto-seeds a CSRF cookie + token for mutating
 * methods (POST/PATCH/PUT/DELETE), leaving GETs untouched. Preserves
 * caller-provided headers/cookies — the CSRF pair is merged in only when
 * not already set.
 */
export async function mutatingInject(
  app: FastifyInstance,
  options: InjectOptions
): Promise<InjectResponse> {
  const method =
    typeof options.method === "string" ? options.method.toUpperCase() : "GET";
  if (!MUTATING_METHODS.has(method)) {
    return app.inject(options);
  }
  const { cookie, token } = await seedCsrf(app);
  const callerHeaders = (options.headers ?? {}) as Record<string, unknown>;
  const callerCookies = (options.cookies ?? {}) as Record<string, string>;

  const hasCsrfHeader = Object.keys(callerHeaders).some(
    (k) => k.toLowerCase() === "x-csrf-token"
  );
  const hasCsrfCookie = "csrf-token" in callerCookies;

  return app.inject({
    ...options,
    headers: hasCsrfHeader
      ? callerHeaders
      : { ...callerHeaders, "x-csrf-token": token },
    cookies: hasCsrfCookie
      ? callerCookies
      : { ...callerCookies, "csrf-token": cookie }
  });
}
