import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, Binary } from "mongodb";
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

const session: AuthSession = {
  user: { id: "user-a", email: "a@b.com" },
  session: {
    id: "sess",
    userId: "user-a",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  }
};

test("DELETE /account returns 401 when unauthenticated", async () => {
  const { app, teardown } = await harness(null);
  // No CSRF seeding: requireUser runs first, so the unauth path still 401s
  // without a token.
  const response = await app.inject({ method: "DELETE", url: "/account" });
  assert.equal(response.statusCode, 401);
  await teardown();
});

test("DELETE /account sets deletionPendingAt and returns a 30-day deletionAt", async () => {
  const { app, uri, teardown } = await harness(session);

  const before = Date.now();
  const response = await mutatingInject(app, {
    method: "DELETE",
    url: "/account"
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  const pendingAt = Date.parse(body.deletionPendingAt);
  const deletionAt = Date.parse(body.deletionAt);
  assert.ok(pendingAt >= before - 1000, "pendingAt should be ~now");
  const windowMs = deletionAt - pendingAt;
  const expectedMs = 30 * 24 * 60 * 60 * 1000;
  assert.equal(windowMs, expectedMs, "30-day window");
  assert.equal(body.windowDays, 30);

  const client = new MongoClient(uri);
  await client.connect();
  const user = await client
    .db("muralist-test")
    .collection("users")
    .findOne({ sub: "user-a" });
  assert.ok(user, "user doc should exist");
  assert.ok(user.deletionPendingAt instanceof Date);
  await client.close();

  await teardown();
});

test("POST /account/delete-cancel clears deletionPendingAt", async () => {
  const { app, uri, teardown } = await harness(session);

  await mutatingInject(app, { method: "DELETE", url: "/account" });
  const cancel = await mutatingInject(app, {
    method: "POST",
    url: "/account/delete-cancel"
  });
  assert.equal(cancel.statusCode, 204);

  const client = new MongoClient(uri);
  await client.connect();
  const user = await client
    .db("muralist-test")
    .collection("users")
    .findOne({ sub: "user-a" });
  assert.ok(user);
  assert.equal(
    "deletionPendingAt" in user && user.deletionPendingAt !== undefined,
    false,
    "deletionPendingAt should be unset after cancel"
  );
  await client.close();

  await teardown();
});

test("GET /export returns the user's projects with base64 image + thumbnail", async () => {
  const { app, uri, teardown } = await harness(session);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb]);
  const thumbBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xcc]);

  const projectResult = await db.collection("projects").insertOne({
    userId: "user-a",
    name: "first project",
    palette: { colors: [{ id: "c1", hex: "#ffaabb", coverage: 1.0 }] },
    sanitizedImage: new Binary(imageBytes),
    metadata: {},
    version: 1,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastViewedAt: new Date()
  });
  await db.collection("project_thumbnails").insertOne({
    projectId: projectResult.insertedId.toHexString(),
    userId: "user-a",
    thumbnail: new Binary(thumbBytes),
    name: "first project",
    lastViewedAt: new Date(),
    status: "active"
  });
  await client.close();

  const response = await app.inject({ method: "GET", url: "/export" });
  assert.equal(response.statusCode, 200);

  const disposition = response.headers["content-disposition"];
  assert.ok(
    typeof disposition === "string" && disposition.startsWith("attachment"),
    "should set attachment disposition"
  );

  const body = response.json();
  assert.equal(body.userId, "user-a");
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.projects.length, 1);
  const project = body.projects[0];
  assert.equal(project.name, "first project");
  assert.equal(project.status, "active");
  assert.equal(project.sanitizedImage, imageBytes.toString("base64"));
  assert.equal(project.thumbnail, thumbBytes.toString("base64"));

  await teardown();
});

test("GET /export returns 401 when unauthenticated", async () => {
  const { app, teardown } = await harness(null);
  const response = await app.inject({ method: "GET", url: "/export" });
  assert.equal(response.statusCode, 401);
  await teardown();
});

test("GET /export includes trashed projects too", async () => {
  const { app, uri, teardown } = await harness(session);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  await db.collection("projects").insertMany([
    {
      userId: "user-a",
      name: "active",
      status: "active",
      palette: { colors: [{ id: "c", hex: "#000000", coverage: 1 }] },
      sanitizedImage: new Binary(Buffer.from([0xff, 0xd8, 0xff])),
      metadata: {},
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastViewedAt: new Date()
    },
    {
      userId: "user-a",
      name: "trashed",
      status: "trashed",
      palette: { colors: [{ id: "c", hex: "#000000", coverage: 1 }] },
      sanitizedImage: new Binary(Buffer.from([0xff, 0xd8, 0xff])),
      metadata: {},
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastViewedAt: new Date(),
      deletedAt: new Date()
    }
  ]);
  await client.close();

  const response = await app.inject({ method: "GET", url: "/export" });
  const body = response.json();
  assert.equal(body.projects.length, 2);
  const statuses = body.projects.map((p: { status: string }) => p.status).sort();
  assert.deepEqual(statuses, ["active", "trashed"]);

  await teardown();
});
