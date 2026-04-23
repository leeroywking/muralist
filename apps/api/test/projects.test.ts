import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import {
  loadTierConfig,
  loadUploadLimits,
  type TierConfig,
  type UploadLimits
} from "@muralist/config";
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

function sessionFor(sub: string, email = "user@example.com"): AuthSession {
  return {
    user: { id: sub, email },
    session: {
      id: `sess-${sub}`,
      userId: sub,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    }
  };
}

async function setupHarness(session: AuthSession | null) {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongod.getUri();
  const tierConfig: TierConfig = await loadTierConfig();
  const uploadLimits: UploadLimits = await loadUploadLimits();

  const app = await buildServer({
    appBaseURL: "http://localhost:3000",
    mongo: { uri, dbName: "muralist-test" },
    auth: stubAuth(session),
    tierConfig,
    uploadLimits
  });

  const teardown = async () => {
    await app.close();
    await mongod.stop();
  };

  return { app, teardown, uri, tierConfig, uploadLimits };
}

/** Minimal JPEG bytes that pass the magic-byte check. */
function jpegBytes(padding = 50): Buffer {
  const header = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0,
    0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00
  ]);
  return Buffer.concat([header, Buffer.alloc(padding, 0x00)]);
}

const SAMPLE_JPEG_B64 = jpegBytes(100).toString("base64");
const SMALL_JPEG_B64 = jpegBytes(20).toString("base64");

function samplePalette() {
  return {
    colors: [
      { id: "c1", hex: "#ff0000", coverage: 0.5 },
      { id: "c2", hex: "#00ff00", coverage: 0.5 }
    ]
  };
}

function createPayload(name = "My Project") {
  return {
    name,
    palette: samplePalette(),
    image: SAMPLE_JPEG_B64,
    thumbnail: SMALL_JPEG_B64
  };
}

test("POST /projects rejects unauthenticated requests with 401", async () => {
  const { app, teardown } = await setupHarness(null);
  const response = await app.inject({
    method: "POST",
    url: "/projects",
    payload: createPayload()
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: "UNAUTHENTICATED" });
  await teardown();
});

test("POST /projects creates 3 projects, 4th via grace-save, 5th rejected 403", async () => {
  const { app, teardown } = await setupHarness(sessionFor("tier-test"));

  for (let i = 1; i <= 3; i++) {
    const response = await mutatingInject(app, {
      method: "POST",
      url: "/projects",
      payload: createPayload(`P${i}`)
    });
    assert.equal(response.statusCode, 201, `create ${i} body=${response.body}`);
  }

  // 4th — one-grace-save: count === 3 === limit, allowed.
  const fourth = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("P4")
  });
  assert.equal(fourth.statusCode, 201, `grace save body=${fourth.body}`);

  // 5th — now overLimit (count=4 > 3), rejected.
  const fifth = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("P5")
  });
  assert.equal(fifth.statusCode, 403);
  assert.deepEqual(fifth.json(), { error: "OVER_TIER_LIMIT" });

  await teardown();
});

test("GET /projects returns tile rows without image bytes but with thumbnail", async () => {
  const { app, teardown } = await setupHarness(sessionFor("list-user"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("Tile One")
  });
  assert.equal(created.statusCode, 201);

  const list = await app.inject({ method: "GET", url: "/projects" });
  assert.equal(list.statusCode, 200);
  const body = list.json() as { projects: Array<Record<string, unknown>> };
  assert.equal(body.projects.length, 1);
  const row = body.projects[0]!;
  assert.equal(row.name, "Tile One");
  assert.equal(row.status, "active");
  assert.equal(typeof row.thumbnail, "string");
  assert.ok((row.thumbnail as string).length > 0);
  assert.equal("sanitizedImage" in row, false);
  assert.equal("palette" in row, false);

  await teardown();
});

test("GET /projects/:id returns full doc with base64 sanitizedImage", async () => {
  const { app, teardown } = await setupHarness(sessionFor("get-one"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("Full")
  });
  const { id } = created.json() as { id: string };

  const full = await app.inject({ method: "GET", url: `/projects/${id}` });
  assert.equal(full.statusCode, 200);
  const body = full.json() as Record<string, unknown>;
  assert.equal(body.id, id);
  assert.equal(body.name, "Full");
  assert.equal(typeof body.sanitizedImage, "string");
  assert.ok((body.sanitizedImage as string).length > 0);
  assert.ok(body.palette);

  await teardown();
});

test("GET /projects/:id returns 404 for another user's project", async () => {
  const ownerSession = sessionFor("owner-abc");
  const { app, teardown, uri } = await setupHarness(ownerSession);

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("Secret")
  });
  const { id } = created.json() as { id: string };

  // Swap the server to a different session and try to fetch the same id.
  await app.close();

  const intruderApp = await buildServer({
    appBaseURL: "http://localhost:3000",
    mongo: { uri, dbName: "muralist-test" },
    auth: stubAuth(sessionFor("intruder-xyz")),
    tierConfig: await loadTierConfig(),
    uploadLimits: await loadUploadLimits()
  });

  const attempt = await intruderApp.inject({
    method: "GET",
    url: `/projects/${id}`
  });
  assert.equal(attempt.statusCode, 404);
  assert.deepEqual(attempt.json(), { error: "NOT_FOUND" });

  await intruderApp.close();
  await teardown();
});

test("PATCH /projects/:id/palette without If-Match returns 428", async () => {
  const { app, teardown } = await setupHarness(sessionFor("pat-428"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("P")
  });
  const { id } = created.json() as { id: string };

  const response = await mutatingInject(app, {
    method: "PATCH",
    url: `/projects/${id}/palette`,
    payload: { palette: samplePalette() }
  });
  assert.equal(response.statusCode, 428);
  assert.deepEqual(response.json(), { error: "PRECONDITION_REQUIRED" });

  await teardown();
});

test("PATCH /projects/:id/palette with stale If-Match returns 409", async () => {
  const { app, teardown } = await setupHarness(sessionFor("pat-409"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("P")
  });
  const { id } = created.json() as { id: string };

  const response = await mutatingInject(app, {
    method: "PATCH",
    url: `/projects/${id}/palette`,
    headers: { "if-match": "99" },
    payload: { palette: samplePalette() }
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), { error: "VERSION_CONFLICT" });

  await teardown();
});

test("PATCH /projects/:id/palette with current If-Match succeeds and bumps version", async () => {
  const { app, teardown } = await setupHarness(sessionFor("pat-ok"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("P")
  });
  const { id } = created.json() as { id: string; version: number };

  const response = await mutatingInject(app, {
    method: "PATCH",
    url: `/projects/${id}/palette`,
    headers: { "if-match": "1" },
    payload: { palette: samplePalette() }
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { version: number };
  assert.equal(body.version, 2);

  await teardown();
});

test("PATCH /projects/:id/image with bad base64 returns 400 INVALID_BASE64", async () => {
  const { app, teardown } = await setupHarness(sessionFor("bad-b64"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("P")
  });
  const { id } = created.json() as { id: string };

  // 17 legal base64 chars with length %4 === 1 → passes the tiny-payload
  // fast-fail and the character regex, but fails the length-mod-4 and
  // round-trip checks → INVALID_BASE64.
  const response = await mutatingInject(app, {
    method: "PATCH",
    url: `/projects/${id}/image`,
    payload: { image: "AAAAAAAAAAAAAAAAA" }
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as { error: string; reason: string };
  assert.equal(body.error, "IMAGE_VALIDATION_FAILED");
  assert.equal(body.reason, "INVALID_BASE64");

  await teardown();
});

test("PATCH /projects/:id/image while overLimit returns 403 OVER_TIER_LIMIT", async () => {
  const session = sessionFor("over-limit");
  const { app, teardown, uri } = await setupHarness(session);

  // Seed user into read-only mode by pre-inserting 4 active projects.
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  const pid = new ObjectId();
  await db.collection("projects").insertMany([
    {
      _id: pid,
      userId: session.user.id,
      status: "active",
      name: "seed-a",
      version: 1
    },
    { userId: session.user.id, status: "active", name: "seed-b", version: 1 },
    { userId: session.user.id, status: "active", name: "seed-c", version: 1 },
    { userId: session.user.id, status: "active", name: "seed-d", version: 1 }
  ]);
  await client.close();

  const response = await mutatingInject(app, {
    method: "PATCH",
    url: `/projects/${pid.toHexString()}/image`,
    payload: { image: SAMPLE_JPEG_B64 }
  });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: "OVER_TIER_LIMIT" });

  await teardown();
});

test("DELETE /projects/:id succeeds even in overLimit (escape valve)", async () => {
  const session = sessionFor("escape-user");
  const { app, teardown, uri } = await setupHarness(session);

  // Create 4 normally-persisted projects to trip overLimit.
  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const res = await mutatingInject(app, {
      method: "POST",
      url: "/projects",
      payload: createPayload(`p${i}`)
    });
    if (i <= 4) {
      assert.equal(res.statusCode, 201, res.body);
    }
    ids.push((res.json() as { id: string }).id);
  }

  // User now overLimit. Write blocked, delete allowed.
  const blocked = await mutatingInject(app, {
    method: "PATCH",
    url: `/projects/${ids[0]}/image`,
    payload: { image: SAMPLE_JPEG_B64 }
  });
  assert.equal(blocked.statusCode, 403);

  const deleted = await mutatingInject(app, {
    method: "DELETE",
    url: `/projects/${ids[0]}`
  });
  assert.equal(deleted.statusCode, 200);

  // Verify status flipped to trashed in both collections.
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  const p = await db
    .collection("projects")
    .findOne({ _id: new ObjectId(ids[0]!) });
  assert.equal(p!.status, "trashed");
  assert.ok(p!.deletedAt);
  const t = await db
    .collection("project_thumbnails")
    .findOne({ projectId: ids[0]! });
  assert.equal(t!.status, "trashed");
  await client.close();

  await teardown();
});

test("POST /projects/:id/restore within 14 days succeeds", async () => {
  const { app, teardown } = await setupHarness(sessionFor("restore-ok"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("R")
  });
  const { id } = created.json() as { id: string };

  const del = await mutatingInject(app, {
    method: "DELETE",
    url: `/projects/${id}`
  });
  assert.equal(del.statusCode, 200);

  const restore = await mutatingInject(app, {
    method: "POST",
    url: `/projects/${id}/restore`
  });
  assert.equal(restore.statusCode, 200, restore.body);
  assert.equal((restore.json() as { status: string }).status, "active");

  await teardown();
});

test("POST /projects/:id/restore past 14 days returns 410 GRACE_EXPIRED", async () => {
  const session = sessionFor("restore-expired");
  const { app, teardown, uri } = await setupHarness(session);

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("R")
  });
  const { id } = created.json() as { id: string };

  // Force delete + push deletedAt back 15 days.
  await mutatingInject(app, { method: "DELETE", url: `/projects/${id}` });
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  const past = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  await db
    .collection("projects")
    .updateOne({ _id: new ObjectId(id) }, { $set: { deletedAt: past } });
  await client.close();

  const restore = await mutatingInject(app, {
    method: "POST",
    url: `/projects/${id}/restore`
  });
  assert.equal(restore.statusCode, 410);
  assert.deepEqual(restore.json(), { error: "GRACE_EXPIRED" });

  await teardown();
});

test("POST /projects/:id/viewed touches lastViewedAt without bumping version", async () => {
  const session = sessionFor("view-user");
  const { app, teardown, uri } = await setupHarness(session);

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("V")
  });
  const { id, version } = created.json() as { id: string; version: number };

  // Wait 5ms to make timestamp comparison reliable.
  await new Promise((r) => setTimeout(r, 5));

  const viewed = await mutatingInject(app, {
    method: "POST",
    url: `/projects/${id}/viewed`
  });
  assert.equal(viewed.statusCode, 200);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("muralist-test");
  const p = await db
    .collection("projects")
    .findOne({ _id: new ObjectId(id) });
  assert.equal(p!.version, version);
  assert.ok(p!.lastViewedAt.getTime() > p!.createdAt.getTime());
  await client.close();

  await teardown();
});

test("GET /projects?status=trashed returns only trashed tiles", async () => {
  const { app, teardown } = await setupHarness(sessionFor("status-filter"));

  const c1 = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("keep")
  });
  const c2 = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("trash-me")
  });
  const trashId = (c2.json() as { id: string }).id;

  await mutatingInject(app, {
    method: "DELETE",
    url: `/projects/${trashId}`
  });

  const activeList = await app.inject({ method: "GET", url: "/projects" });
  const trashedList = await app.inject({
    method: "GET",
    url: "/projects?status=trashed"
  });

  const activeIds = (
    activeList.json() as { projects: Array<{ id: string }> }
  ).projects.map((p) => p.id);
  const trashedIds = (
    trashedList.json() as { projects: Array<{ id: string }> }
  ).projects.map((p) => p.id);

  assert.deepEqual(activeIds, [(c1.json() as { id: string }).id]);
  assert.deepEqual(trashedIds, [trashId]);

  await teardown();
});

test("GET /projects/:id for trashed project returns 410 without includeTrashed", async () => {
  const { app, teardown } = await setupHarness(sessionFor("trashed-get"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("T")
  });
  const { id } = created.json() as { id: string };
  await mutatingInject(app, { method: "DELETE", url: `/projects/${id}` });

  const denied = await app.inject({ method: "GET", url: `/projects/${id}` });
  assert.equal(denied.statusCode, 410);

  const allowed = await app.inject({
    method: "GET",
    url: `/projects/${id}?includeTrashed=true`
  });
  assert.equal(allowed.statusCode, 200);

  await teardown();
});

test("PATCH /projects/:id/metadata updates name and mirrors to thumbnail tile", async () => {
  const { app, teardown } = await setupHarness(sessionFor("meta-user"));

  const created = await mutatingInject(app, {
    method: "POST",
    url: "/projects",
    payload: createPayload("Old Name")
  });
  const { id } = created.json() as { id: string };

  const update = await mutatingInject(app, {
    method: "PATCH",
    url: `/projects/${id}/metadata`,
    payload: { name: "New Name" }
  });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal((update.json() as { version: number }).version, 2);

  const list = await app.inject({ method: "GET", url: "/projects" });
  const row = (list.json() as { projects: Array<{ name: string }> })
    .projects[0]!;
  assert.equal(row.name, "New Name");

  await teardown();
});
