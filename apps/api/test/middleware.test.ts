import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { loadTierConfig, type TierConfig } from "@muralist/config";
import { buildServer } from "../src/server.js";
import type { AuthInstance, AuthSession } from "../src/auth.js";

if (!globalThis.crypto) {
  // Node 18 lacks global web crypto; mongodb@7 needs it.
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as Crypto;
}

function stubAuth(session: AuthSession | null): AuthInstance {
  return {
    handler: async () =>
      new Response(null, { status: 204 }),
    api: {
      getSession: async () => session
    }
  };
}

async function setupTestHarness(session: AuthSession | null) {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongod.getUri();
  const tierConfig: TierConfig = await loadTierConfig();

  const app = await buildServer({
    appBaseURL: "http://localhost:3000",
    mongo: { uri, dbName: "muralist-test" },
    auth: stubAuth(session),
    tierConfig
  });

  const teardown = async () => {
    await app.close();
    await mongod.stop();
  };

  return { app, teardown, uri, tierConfig };
}

test("requireUser blocks unauthenticated requests with 401", async () => {
  const { app, teardown } = await setupTestHarness(null);

  app.get(
    "/private",
    { preHandler: app.requireUser },
    async () => ({ ok: true })
  );

  const response = await app.inject({ method: "GET", url: "/private" });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: "UNAUTHENTICATED" });

  await teardown();
});

test("requireUser attaches request.user on valid session", async () => {
  const session: AuthSession = {
    user: { id: "user-abc", email: "a@b.com" },
    session: {
      id: "sess-1",
      userId: "user-abc",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    }
  };

  const { app, teardown } = await setupTestHarness(session);

  app.get(
    "/whoami",
    { preHandler: app.requireUser },
    async (request) => ({ sub: request.user?.sub, email: request.user?.email })
  );

  const response = await app.inject({ method: "GET", url: "/whoami" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { sub: "user-abc", email: "a@b.com" });

  await teardown();
});

test("computeLimits reports atLimit=true when count === projectLimit", async () => {
  const session: AuthSession = {
    user: { id: "user-at-limit" },
    session: {
      id: "sess",
      userId: "user-at-limit",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    }
  };
  const { app, teardown, uri } = await setupTestHarness(session);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  await db.collection("projects").insertMany([
    { userId: "user-at-limit", status: "active", name: "p1" },
    { userId: "user-at-limit", status: "active", name: "p2" },
    { userId: "user-at-limit", status: "active", name: "p3" }
  ]);
  await client.close();

  app.get(
    "/limits",
    {
      preHandler: [
        app.requireUser,
        async (req) => {
          await app.computeLimits(req);
        }
      ]
    },
    async (request) => request.limits
  );

  const response = await app.inject({ method: "GET", url: "/limits" });
  const body = response.json();
  assert.equal(response.statusCode, 200);
  assert.equal(body.activeProjectCount, 3);
  assert.equal(body.projectLimit, 3);
  assert.equal(body.atLimit, true);
  assert.equal(body.overLimit, false);

  await teardown();
});

test("assertWriteAllowed passes at atLimit (one-grace-save) but blocks at overLimit", async () => {
  const session: AuthSession = {
    user: { id: "user-over-limit" },
    session: {
      id: "sess",
      userId: "user-over-limit",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    }
  };
  const { app, teardown, uri } = await setupTestHarness(session);

  // Seed 4 active projects → count > limit=3 → overLimit=true.
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  await db.collection("projects").insertMany([
    { userId: "user-over-limit", status: "active", name: "p1" },
    { userId: "user-over-limit", status: "active", name: "p2" },
    { userId: "user-over-limit", status: "active", name: "p3" },
    { userId: "user-over-limit", status: "active", name: "p4" }
  ]);
  await client.close();

  app.post(
    "/try-write",
    {
      preHandler: [
        app.requireUser,
        async (req) => {
          await app.computeLimits(req);
        }
      ]
    },
    async (request) => {
      app.assertWriteAllowed(request);
      return { ok: true };
    }
  );

  const response = await app.inject({ method: "POST", url: "/try-write" });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: "OVER_TIER_LIMIT" });

  await teardown();
});

test("assertWriteAllowed with allowInReadOnly bypasses the check", async () => {
  const session: AuthSession = {
    user: { id: "user-delete-case" },
    session: {
      id: "sess",
      userId: "user-delete-case",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    }
  };
  const { app, teardown, uri } = await setupTestHarness(session);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  await db.collection("projects").insertMany([
    { userId: "user-delete-case", status: "active", name: "p1" },
    { userId: "user-delete-case", status: "active", name: "p2" },
    { userId: "user-delete-case", status: "active", name: "p3" },
    { userId: "user-delete-case", status: "active", name: "p4" }
  ]);
  await client.close();

  app.delete(
    "/escape",
    {
      preHandler: [
        app.requireUser,
        async (req) => {
          await app.computeLimits(req);
        }
      ]
    },
    async (request) => {
      app.assertWriteAllowed(request, { allowInReadOnly: true });
      return { deleted: true };
    }
  );

  const response = await app.inject({ method: "DELETE", url: "/escape" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { deleted: true });

  await teardown();
});
