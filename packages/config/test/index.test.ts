import test from "node:test";
import assert from "node:assert/strict";
import { loadPaintBrandCatalog } from "../src/index.js";

test("paint brand catalog loads and validates", async () => {
  const catalog = await loadPaintBrandCatalog();

  assert.equal(catalog.version, 1);
  assert.equal(catalog.brands.length, 3);
  assert.equal(catalog.units.coverage, "sqft_per_gallon");
});

