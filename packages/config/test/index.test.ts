import test from "node:test";
import assert from "node:assert/strict";
import {
  loadPaintBrandCatalog,
  validateCatalog,
  type PaintBrandCatalog
} from "../src/index.js";

test("paint brand catalog loads and validates", async () => {
  const catalog = await loadPaintBrandCatalog();

  assert.equal(catalog.version, 1);
  assert.equal(catalog.brands.length, 3);
  assert.equal(catalog.units.coverage, "sqft_per_gallon");
  assert.equal(catalog.units.price, "usd_per_unit");
});

test("every brand exposes prices and at least one finish", async () => {
  const catalog = await loadPaintBrandCatalog();

  for (const brand of catalog.brands) {
    assert.ok(brand.prices.sample > 0, `${brand.id} sample price must be positive`);
    assert.ok(brand.prices.quart > 0, `${brand.id} quart price must be positive`);
    assert.ok(brand.prices.gallon > 0, `${brand.id} gallon price must be positive`);
    assert.ok(brand.finishes.length >= 1, `${brand.id} must expose at least one finish`);
    for (const finish of brand.finishes) {
      assert.ok(
        finish.coverage_multiplier > 0,
        `${brand.id} finish ${finish.id} multiplier must be positive`
      );
    }
  }
});

test("validator rejects a brand with non-positive quart price", () => {
  const catalog = buildFixtureCatalog();
  catalog.brands[0]!.prices.quart = 0;
  assert.throws(() => validateCatalog(catalog), /prices\.quart/);
});

test("validator rejects a brand with non-positive sample price", () => {
  const catalog = buildFixtureCatalog();
  catalog.brands[0]!.prices.sample = 0;
  assert.throws(() => validateCatalog(catalog), /prices\.sample/);
});

test("validator rejects a brand with empty finishes", () => {
  const catalog = buildFixtureCatalog();
  catalog.brands[0]!.finishes = [];
  assert.throws(() => validateCatalog(catalog), /at least one finish/);
});

test("validator rejects duplicate finish ids on a brand", () => {
  const catalog = buildFixtureCatalog();
  catalog.brands[0]!.finishes = [
    { id: "flat", display_name: "Flat", coverage_multiplier: 1.0 },
    { id: "flat", display_name: "Flat Again", coverage_multiplier: 0.9 }
  ];
  assert.throws(() => validateCatalog(catalog), /duplicate finish id/);
});

test("validator rejects a finish with non-positive coverage_multiplier", () => {
  const catalog = buildFixtureCatalog();
  catalog.brands[0]!.finishes[0]!.coverage_multiplier = 0;
  assert.throws(() => validateCatalog(catalog), /coverage_multiplier/);
});

function buildFixtureCatalog(): PaintBrandCatalog {
  return {
    version: 1,
    units: { coverage: "sqft_per_gallon", price: "usd_per_unit" },
    brands: [
      {
        id: "fixture_brand",
        display_name: "Fixture Brand",
        retailer: "Fixture Retailer",
        coverage: { min: 300, default: 350, max: 400 },
        default_coats: 2,
        confidence: "rough_official_range",
        notes: "Test fixture only.",
        sources: [],
        prices: { currency: "USD", sample: 6, quart: 15, gallon: 35 },
        finishes: [
          { id: "flat", display_name: "Flat", coverage_multiplier: 1.0 },
          { id: "satin", display_name: "Satin", coverage_multiplier: 0.95 }
        ]
      }
    ]
  };
}
