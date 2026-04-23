import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { loadTierConfig, type TierConfig } from "@muralist/config";
import { buildServer } from "../src/server.js";
import type { AuthInstance, AuthSession } from "../src/auth.js";
import { mutatingInject } from "./_csrfHelper.js";

if (!globalThis.crypto) {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as Crypto;
}

function stubAuth(session: AuthSession | null): AuthInstance {
  return {
    handler: async () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => session
    }
  };
}

async function harness(session: AuthSession | null) {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongod.getUri();
  const tierConfig: TierConfig = await loadTierConfig();

  const app = await buildServer({
    appBaseURL: "http://localhost:3000",
    mongo: { uri, dbName: "muralist-test" },
    auth: stubAuth(session),
    tierConfig
  });

  return {
    app,
    uri,
    teardown: async () => {
      await app.close();
      await mongod.stop();
    }
  };
}

const baseSession: AuthSession = {
  user: { id: "user-1", email: "u1@example.com" },
  session: {
    id: "sess-1",
    userId: "user-1",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  }
};

test("GET /me returns 401 when unauthenticated", async () => {
  const { app, teardown } = await harness(null);

  const response = await app.inject({ method: "GET", url: "/me" });
  assert.equal(response.statusCode, 401);

  await teardown();
});

test("GET /me lazy-creates the user doc on first call and returns defaults", async () => {
  const { app, uri, teardown } = await harness(baseSession);

  const response = await app.inject({ method: "GET", url: "/me" });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.sub, "user-1");
  assert.equal(body.email, "u1@example.com");
  assert.equal(body.tier, "free");
  assert.equal(body.effectiveTier, "free");
  assert.equal(body.subscriptionStatus, "none");
  assert.equal(body.projectLimit, 3);
  assert.equal(body.activeProjectCount, 0);
  assert.equal(body.atLimit, false);
  assert.equal(body.overLimit, false);
  assert.deepEqual(body.linkedProviders, []);
  assert.deepEqual(body.proSettings, {});

  // Confirm the user doc was actually persisted.
  const client = new MongoClient(uri);
  await client.connect();
  const user = await client
    .db("muralist-test")
    .collection("users")
    .findOne({ sub: "user-1" });
  assert.ok(user, "user doc should exist after first /me call");
  assert.equal(user.tier, "free");
  await client.close();

  await teardown();
});

test("GET /me reflects overLimit=true when activeProjectCount > limit", async () => {
  const { app, uri, teardown } = await harness(baseSession);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  await db.collection("projects").insertMany(
    Array.from({ length: 5 }, (_, i) => ({
      userId: "user-1",
      status: "active",
      name: `p${i}`
    }))
  );
  await client.close();

  const response = await app.inject({ method: "GET", url: "/me" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.activeProjectCount, 5);
  assert.equal(body.atLimit, false);
  assert.equal(body.overLimit, true);

  await teardown();
});

test("PATCH /me/pro-settings updates the user doc and returns 204", async () => {
  const { app, uri, teardown } = await harness(baseSession);

  const response = await mutatingInject(app, {
    method: "PATCH",
    url: "/me/pro-settings",
    payload: {
      autoCombineSensitivity: "conservative",
      residualThreshold: 18,
      mixCoveragePercent: 5
    }
  });
  assert.equal(response.statusCode, 204);

  const client = new MongoClient(uri);
  await client.connect();
  const user = await client
    .db("muralist-test")
    .collection("users")
    .findOne({ sub: "user-1" });
  assert.ok(user, "user doc should exist");
  assert.equal(user.proSettings.autoCombineSensitivity, "conservative");
  assert.equal(user.proSettings.residualThreshold, 18);
  assert.equal(user.proSettings.mixCoveragePercent, 5);
  await client.close();

  await teardown();
});

test("PATCH /me/pro-settings rejects invalid payloads with 400", async () => {
  const { app, teardown } = await harness(baseSession);

  const response = await mutatingInject(app, {
    method: "PATCH",
    url: "/me/pro-settings",
    payload: {
      autoCombineSensitivity: "nonsense-preset"
    }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "INVALID_PAYLOAD");

  await teardown();
});

test("PATCH /me/pro-settings requires an authenticated session", async () => {
  const { app, teardown } = await harness(null);

  // No mutatingInject here: the test specifically exercises the unauthed
  // path. requireUser runs before csrfProtection in the preHandler chain,
  // so a missing CSRF token does NOT mask the 401.
  const response = await app.inject({
    method: "PATCH",
    url: "/me/pro-settings",
    payload: { autoCombineSensitivity: "balanced" }
  });
  assert.equal(response.statusCode, 401);

  await teardown();
});

test("PATCH /me/pro-settings merges with existing settings instead of replacing", async () => {
  const { app, uri, teardown } = await harness(baseSession);

  // First PATCH seeds two fields.
  await mutatingInject(app, {
    method: "PATCH",
    url: "/me/pro-settings",
    payload: {
      autoCombineSensitivity: "aggressive",
      residualThreshold: 28
    }
  });

  // Second PATCH updates only one field; the other two should remain.
  await mutatingInject(app, {
    method: "PATCH",
    url: "/me/pro-settings",
    payload: { mixCoveragePercent: 10 }
  });

  const client = new MongoClient(uri);
  await client.connect();
  const user = await client
    .db("muralist-test")
    .collection("users")
    .findOne({ sub: "user-1" });
  assert.ok(user);
  assert.equal(user.proSettings.autoCombineSensitivity, "aggressive");
  assert.equal(user.proSettings.residualThreshold, 28);
  assert.equal(user.proSettings.mixCoveragePercent, 10);
  await client.close();

  await teardown();
});
