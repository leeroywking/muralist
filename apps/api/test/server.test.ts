import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";

test("health endpoint responds", async () => {
  const app = await buildServer();
  const response = await app.inject({
    method: "GET",
    url: "/health"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    service: "muralist-api"
  });

  await app.close();
});

test("brand catalog endpoint returns seeded brands", async () => {
  const app = await buildServer();
  const response = await app.inject({
    method: "GET",
    url: "/api/paint-brands"
  });
  const payload = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(payload.brands.length, 3);

  await app.close();
});

test("estimate endpoint computes gallons from a brand profile", async () => {
  const app = await buildServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/estimate",
    payload: {
      brandId: "sherwin_williams",
      areaSqFt: 750,
      coats: 2,
      wasteFactor: 0.1
    }
  });
  const payload = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(payload.brandId, "sherwin_williams");
  assert.equal(payload.recommendedGallons, 4.4);

  await app.close();
});

