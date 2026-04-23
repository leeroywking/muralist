import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createAuth } from "../src/auth.js";
import { buildServer } from "../src/server.js";

// Node 18 does not expose `globalThis.crypto` by default; the mongodb driver
// expects it to be present. Production runs on Node >=20 where this is a
// no-op. Keeping the polyfill local to the test file so app code doesn't
// depend on it.
if (typeof (globalThis as { crypto?: unknown }).crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true
  });
}

const TEST_BASE_URL = "http://localhost:3000";

test("buildServer accepts a stub auth instance and keeps capabilities endpoint", async () => {
  const calls: string[] = [];
  const stubAuth = {
    handler: async (request: Request) => {
      calls.push(new URL(request.url).pathname);
      return new Response(JSON.stringify({ stub: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  } as unknown as Parameters<typeof buildServer>[0]["auth"];

  const app = await buildServer({
    appBaseURL: TEST_BASE_URL,
    auth: stubAuth
  });

  // capabilities endpoint must still respond with the core payload — static
  // route precedence over the /api/auth/* wildcard.
  const capRes = await app.inject({
    method: "GET",
    url: "/api/auth/capabilities"
  });
  assert.equal(capRes.statusCode, 200);
  const capBody = capRes.json() as { auth: unknown };
  assert.ok(capBody.auth, "expected capabilities payload under `auth`");

  // a non-capabilities path under /api/auth/* falls through to the stub.
  const stubRes = await app.inject({
    method: "GET",
    url: "/api/auth/session"
  });
  assert.equal(stubRes.statusCode, 200);
  assert.deepEqual(stubRes.json(), { stub: true });
  assert.deepEqual(calls, ["/api/auth/session"]);

  await app.close();
});

test("Better Auth get-session endpoint returns null when unauthenticated", async () => {
  // Better Auth's Mongo adapter enables transactions by default; the memory
  // server must be a replica set (single-node) for transactions to work.
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 }
  });
  const uri = replSet.getUri();
  const dbName = "muralist_test";

  const client = new MongoClient(uri);
  await client.connect();

  try {
    const { auth } = createAuth({
      client,
      dbName,
      secret: "test-secret-at-least-32-chars-long-xxxxxxxxxx",
      appBaseURL: TEST_BASE_URL,
      providers: {}
    });

    const app = await buildServer({
      appBaseURL: TEST_BASE_URL,
      mongo: { uri, dbName },
      auth
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/get-session"
    });

    // Better Auth returns 200 with a JSON `null` body for an unauthenticated
    // request — no session, no user, no error.
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "null");

    await app.close();
  } finally {
    await client.close();
    await replSet.stop();
  }
});
