import test from "node:test";
import assert from "node:assert/strict";
import { loadPaintBrandCatalog } from "@muralist/config";
import { estimatePaintRequirement, getAuthCapabilities } from "../src/index.js";

test("guest mode cannot persist data", () => {
  const auth = getAuthCapabilities();

  assert.equal(auth.mode, "oauth_only");
  assert.equal(auth.guest.canPersistData, false);
});

test("paint estimation uses configured brand defaults", async () => {
  const catalog = await loadPaintBrandCatalog();
  const result = estimatePaintRequirement(
    {
      brandId: "behr",
      areaSqFt: 500
    },
    catalog
  );

  assert.deepEqual(result, {
    brandId: "behr",
    areaSqFt: 500,
    coats: 2,
    wasteFactor: 0.1,
    coverageSqFtPerGallon: 325,
    recommendedGallons: 3.4
  });
});

