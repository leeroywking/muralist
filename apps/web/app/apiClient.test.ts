// Unit tests for `apiClient.ts` covering CSRF header injection and
// error-code mapping for the status codes the server produces.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  OverLimitError,
  PreconditionRequiredError,
  UnauthenticatedError,
  VersionConflictError,
  apiRequest,
  createProject,
  deleteProject,
  getMe,
  readCsrfToken,
  updatePalette
} from "./apiClient.js";

type CapturedRequest = {
  url: string;
  init: RequestInit;
};

type MockOptions = {
  status?: number;
  body?: unknown;
  contentType?: string;
};

// Statuses that the Fetch spec forbids from carrying a body.
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
    const payload =
      typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { "content-type": contentType }
    });
  }) as typeof fetch;
}

const baseUrl = "http://api.test";

test("readCsrfToken extracts the csrf-token cookie value", () => {
  const doc = { cookie: "sid=abc; csrf-token=tok-123; other=zzz" };
  assert.equal(readCsrfToken(doc), "tok-123");
});

test("readCsrfToken returns null when cookie absent", () => {
  const doc = { cookie: "sid=abc; other=zzz" };
  assert.equal(readCsrfToken(doc), null);
});

test("readCsrfToken URL-decodes the cookie value", () => {
  const doc = { cookie: `csrf-token=${encodeURIComponent("a b+c/d")}` };
  assert.equal(readCsrfToken(doc), "a b+c/d");
});

test("GET /me does not send an X-CSRF-Token header and sets credentials include", async () => {
  const captured: CapturedRequest[] = [];
  await getMe({
    fetchImpl: mockFetch(captured, {
      status: 200,
      body: { tier: "free" }
    }),
    baseUrl,
    documentLike: { cookie: "csrf-token=should-not-leak" }
  });
  assert.equal(captured.length, 1);
  const entry = captured[0];
  assert.ok(entry);
  assert.equal(entry.url, `${baseUrl}/me`);
  assert.equal(entry.init.method, "GET");
  assert.equal(entry.init.credentials, "include");
  const headers = entry.init.headers as Record<string, string> | undefined;
  assert.ok(headers);
  assert.ok(
    !("x-csrf-token" in (headers ?? {})),
    "CSRF header must not ride on GET requests"
  );
});

test("mutating requests inject the X-CSRF-Token header from the cookie", async () => {
  const captured: CapturedRequest[] = [];
  await createProject(
    {
      name: "Test",
      palette: { colors: [] },
      image: "AAAA",
      thumbnail: "BBBB"
    },
    {
      fetchImpl: mockFetch(captured, {
        status: 201,
        body: { id: "p1" }
      }),
      baseUrl,
      documentLike: { cookie: "csrf-token=abc-123" }
    }
  );
  assert.equal(captured.length, 1);
  const entry = captured[0];
  assert.ok(entry);
  const headers = entry.init.headers as Record<string, string>;
  assert.equal(headers["x-csrf-token"], "abc-123");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(entry.init.method, "POST");
  assert.equal(entry.init.credentials, "include");
});

test("DELETE requests also inject the CSRF header", async () => {
  const captured: CapturedRequest[] = [];
  await deleteProject("proj-9", {
    fetchImpl: mockFetch(captured, { status: 204, body: "" }),
    baseUrl,
    documentLike: { cookie: "csrf-token=delete-token" }
  });
  const entry = captured[0];
  assert.ok(entry);
  const headers = entry.init.headers as Record<string, string>;
  assert.equal(headers["x-csrf-token"], "delete-token");
  assert.equal(entry.init.method, "DELETE");
});

test("updatePalette sets the If-Match header from the version argument", async () => {
  const captured: CapturedRequest[] = [];
  await updatePalette(
    "proj-1",
    { colors: [] },
    7,
    {
      fetchImpl: mockFetch(captured, { status: 204, body: "" }),
      baseUrl,
      documentLike: { cookie: "csrf-token=ver-token" }
    }
  );
  const entry = captured[0];
  assert.ok(entry);
  const headers = entry.init.headers as Record<string, string>;
  assert.equal(headers["if-match"], "7");
  assert.equal(headers["x-csrf-token"], "ver-token");
  assert.equal(entry.init.method, "PATCH");
});

test("401 responses map to UnauthenticatedError", async () => {
  await assert.rejects(
    () =>
      apiRequest("/me", {
        fetchImpl: mockFetch([], { status: 401, body: { error: "UNAUTH" } }),
        baseUrl
      }),
    (err: unknown) => {
      assert.ok(err instanceof UnauthenticatedError);
      assert.equal((err as UnauthenticatedError).status, 401);
      return true;
    }
  );
});

test("403 responses map to OverLimitError and surface the error code", async () => {
  await assert.rejects(
    () =>
      apiRequest("/projects", {
        method: "POST",
        body: {},
        fetchImpl: mockFetch([], {
          status: 403,
          body: { error: "OVER_TIER_LIMIT" }
        }),
        baseUrl,
        documentLike: { cookie: "csrf-token=x" }
      }),
    (err: unknown) => {
      assert.ok(err instanceof OverLimitError);
      assert.equal((err as OverLimitError).code, "OVER_TIER_LIMIT");
      return true;
    }
  );
});

test("409 responses map to VersionConflictError", async () => {
  await assert.rejects(
    () =>
      apiRequest("/projects/p1/palette", {
        method: "PATCH",
        body: { palette: {} },
        headers: { "if-match": "3" },
        fetchImpl: mockFetch([], {
          status: 409,
          body: { error: "VERSION_CONFLICT" }
        }),
        baseUrl,
        documentLike: { cookie: "csrf-token=x" }
      }),
    (err: unknown) => err instanceof VersionConflictError
  );
});

test("428 responses map to PreconditionRequiredError", async () => {
  await assert.rejects(
    () =>
      apiRequest("/projects/p1/palette", {
        method: "PATCH",
        body: { palette: {} },
        fetchImpl: mockFetch([], {
          status: 428,
          body: { error: "PRECONDITION_REQUIRED" }
        }),
        baseUrl,
        documentLike: { cookie: "csrf-token=x" }
      }),
    (err: unknown) => err instanceof PreconditionRequiredError
  );
});

test("other non-2xx responses map to the generic ApiError with status + body", async () => {
  await assert.rejects(
    () =>
      apiRequest("/me", {
        fetchImpl: mockFetch([], {
          status: 500,
          body: { error: "BOOM" }
        }),
        baseUrl
      }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal((err as ApiError).status, 500);
      assert.deepEqual((err as ApiError).body, { error: "BOOM" });
      // Must not be one of the more-specific subclasses.
      assert.ok(!(err instanceof UnauthenticatedError));
      assert.ok(!(err instanceof OverLimitError));
      assert.ok(!(err instanceof VersionConflictError));
      assert.ok(!(err instanceof PreconditionRequiredError));
      return true;
    }
  );
});

test("2xx responses with no body do not throw", async () => {
  const captured: CapturedRequest[] = [];
  await deleteProject("p2", {
    fetchImpl: mockFetch(captured, {
      status: 204,
      body: "",
      contentType: "text/plain"
    }),
    baseUrl,
    documentLike: { cookie: "csrf-token=x" }
  });
  assert.equal(captured.length, 1);
});
