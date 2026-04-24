// Unit tests for the sign-in apiClient wrappers (`signInSocial`, `signOut`).
// Covers what we can test without a real browser: that the wrapper POSTs to
// the right path with the right body, returns the redirect URL, and surfaces
// errors from the server. The full OAuth round-trip (provider consent + cookie
// set + `/me` hydration) needs a real browser and a live Better Auth deploy,
// so that path is marked t.skip with a note.

import test from "node:test";
import assert from "node:assert/strict";

import { ApiError, signInSocial, signOut } from "./apiClient.js";

type CapturedRequest = {
  url: string;
  init: RequestInit;
};

type MockOptions = {
  status?: number;
  body?: unknown;
  contentType?: string;
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function mockFetch(
  captured: CapturedRequest[],
  opts: MockOptions = {}
): typeof fetch {
  const {
    status = 200,
    body = {},
    contentType = "application/json"
  } = opts;
  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    captured.push({ url: String(url), init });
    if (NULL_BODY_STATUSES.has(status)) {
      return new Response(null, {
        status,
        headers: { "content-type": contentType }
      });
    }
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { "content-type": contentType }
    });
  }) as typeof fetch;
}

const baseUrl = "http://api.test";

test("signInSocial POSTs to /api/auth/sign-in/social with the provider payload", async () => {
  const captured: CapturedRequest[] = [];
  const response = await signInSocial(
    { provider: "google", callbackURL: "https://muraliste.com/" },
    {
      fetchImpl: mockFetch(captured, {
        status: 200,
        body: {
          url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=…",
          redirect: true
        }
      }),
      baseUrl,
      documentLike: { cookie: "csrf-token=tok-1" }
    }
  );
  assert.equal(captured.length, 1);
  const entry = captured[0];
  assert.ok(entry);
  assert.equal(entry.url, `${baseUrl}/api/auth/sign-in/social`);
  assert.equal(entry.init.method, "POST");
  assert.equal(entry.init.credentials, "include");
  const headers = entry.init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  // Better Auth endpoints don't enforce CSRF, but the wrapper still injects
  // the header on mutating requests — verify so we notice if that changes.
  assert.equal(headers["x-csrf-token"], "tok-1");
  const bodyJson = JSON.parse(String(entry.init.body));
  assert.deepEqual(bodyJson, {
    provider: "google",
    callbackURL: "https://muraliste.com/"
  });
  assert.equal(
    response.url,
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=…"
  );
});

test("signInSocial surfaces the server error body on non-2xx", async () => {
  await assert.rejects(
    () =>
      signInSocial(
        { provider: "google", callbackURL: "https://muraliste.com/" },
        {
          fetchImpl: mockFetch([], {
            status: 500,
            body: { error: "PROVIDER_MISCONFIGURED" }
          }),
          baseUrl,
          documentLike: { cookie: "csrf-token=x" }
        }
      ),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal((err as ApiError).status, 500);
      assert.deepEqual((err as ApiError).body, {
        error: "PROVIDER_MISCONFIGURED"
      });
      return true;
    }
  );
});

test("signOut POSTs to /api/auth/sign-out with credentials included", async () => {
  const captured: CapturedRequest[] = [];
  await signOut({
    fetchImpl: mockFetch(captured, { status: 200, body: { success: true } }),
    baseUrl,
    documentLike: { cookie: "csrf-token=tok-2" }
  });
  assert.equal(captured.length, 1);
  const entry = captured[0];
  assert.ok(entry);
  assert.equal(entry.url, `${baseUrl}/api/auth/sign-out`);
  assert.equal(entry.init.method, "POST");
  assert.equal(entry.init.credentials, "include");
});

test.skip(
  "full OAuth round-trip (consent + cookie set + /me hydration) — browser-only",
  () => {
    // Covered by the manual test plan in docs/plans/web-ui-post-backend.md.
    // Requires a real browser (window.location + third-party consent screen +
    // cross-site cookie) plus a live Better Auth deploy on a matching origin,
    // neither of which this node:test harness can provide.
  }
);
