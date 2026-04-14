import test from "node:test";
import assert from "node:assert/strict";
import type { PaintBrandCatalog } from "@muralist/config";
import { loadPaintBrandCatalog } from "@muralist/config";
import {
  estimatePaintRequirement,
  getAuthCapabilities,
  suggestContainersForColors
} from "../src/index.js";

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
    finishId: "flat",
    coverageMultiplier: 1.0,
    coverageSqFtPerGallon: 325,
    recommendedGallons: 3.4
  });
});

test("C: different finishIds produce different required gallons in the direction of the multiplier", async () => {
  const catalog = await loadPaintBrandCatalog();
  const flat = estimatePaintRequirement(
    { brandId: "behr", areaSqFt: 500, finishId: "flat" },
    catalog
  );
  const semiGloss = estimatePaintRequirement(
    { brandId: "behr", areaSqFt: 500, finishId: "semi_gloss" },
    catalog
  );

  // semi_gloss has a lower coverage_multiplier than flat, so it should require more paint
  assert.ok(
    semiGloss.recommendedGallons > flat.recommendedGallons,
    `expected semi_gloss (${semiGloss.recommendedGallons}) > flat (${flat.recommendedGallons})`
  );
  assert.equal(semiGloss.finishId, "semi_gloss");
  assert.equal(flat.finishId, "flat");
});

test("C: omitted finishId defaults to the brand's first listed finish", async () => {
  const catalog = await loadPaintBrandCatalog();
  const result = estimatePaintRequirement({ brandId: "valspar", areaSqFt: 400 }, catalog);
  const firstFinishId = catalog.brands.find((entry) => entry.id === "valspar")!.finishes[0]!.id;

  assert.equal(result.finishId, firstFinishId);
});

test("C: unknown finishId throws", async () => {
  const catalog = await loadPaintBrandCatalog();
  assert.throws(
    () =>
      estimatePaintRequirement(
        { brandId: "behr", areaSqFt: 500, finishId: "not_a_real_finish" },
        catalog
      ),
    /Unknown finishId/
  );
});

test("E: every merged color gets at least one container, totals respect N-container floor", async () => {
  const catalog = await loadPaintBrandCatalog();
  const colors = Array.from({ length: 6 }, (_, index) => ({
    id: `color-${index + 1}`,
    coveragePercent: 1 // trivially small per-color coverage
  }));

  const plan = suggestContainersForColors(
    { brandId: "behr", areaSqFt: 50, colors },
    catalog
  );

  assert.equal(plan.perColor.length, 6);
  for (const entry of plan.perColor) {
    const unitCount = entry.packages.reduce((sum, pkg) => sum + pkg.count, 0);
    assert.ok(unitCount >= 1, `${entry.colorId} must have at least one container`);
  }
  const totalUnits = plan.totals.gallons + plan.totals.quarts + plan.totals.samples;
  assert.ok(totalUnits >= colors.length, `expected >= ${colors.length} total containers, got ${totalUnits}`);
});

test("G (no round-up): when 4 quarts cost less than a gallon, fractional colors stay as quarts", () => {
  const catalog = buildCheapQuartsCatalog();
  const plan = suggestContainersForColors(
    {
      brandId: "fixture_cheap_qt",
      areaSqFt: 1000,
      coats: 2,
      wasteFactor: 0,
      colors: [{ id: "c1", coveragePercent: 30 }]
    },
    catalog
  );

  const entry = plan.perColor[0]!;
  // requiredGallons ≈ (1000 * 0.30 * 2) / 400 = 1.5 → 1 gal + 2 qt, and 2 * $5 < $50 so no round-up
  const gallonEntry = entry.packages.find((pkg) => pkg.unit === "gallon");
  const quartEntry = entry.packages.find((pkg) => pkg.unit === "quart");
  assert.equal(gallonEntry?.count, 1);
  assert.equal(quartEntry?.count, 2);
});

test("G (round-up): when quart cost is high enough that k quarts cost >= a gallon, round up to a gallon", () => {
  const catalog = buildExpensiveQuartsCatalog();
  const plan = suggestContainersForColors(
    {
      brandId: "fixture_expensive_qt",
      areaSqFt: 600,
      coats: 2,
      wasteFactor: 0,
      colors: [{ id: "c1", coveragePercent: 25 }]
    },
    catalog
  );

  // requiredGallons ≈ (600 * 0.25 * 2) / 400 = 0.75 → naïvely 3 quarts.
  // qt price 14, gallon 30 → 3 * 14 = 42 >= 30, so round up to 1 gallon.
  const entry = plan.perColor[0]!;
  const gallonEntry = entry.packages.find((pkg) => pkg.unit === "gallon");
  const quartEntry = entry.packages.find((pkg) => pkg.unit === "quart");
  assert.equal(gallonEntry?.count, 1);
  assert.equal(quartEntry, undefined);
});

test("D + G: colors never share containers — 6 detail colors become 6 separate samples", () => {
  const catalog = buildCheapQuartsCatalog();
  const plan = suggestContainersForColors(
    {
      brandId: "fixture_cheap_qt",
      areaSqFt: 50,
      coats: 1,
      wasteFactor: 0,
      colors: Array.from({ length: 6 }, (_, index) => ({
        id: `tiny-${index}`,
        coveragePercent: 1
      }))
    },
    catalog
  );

  // Each color needs a tiny fraction of a gallon; samples are cheaper than
  // quarts in this fixture, so D prefers samples for detail colors.
  assert.equal(plan.totals.samples, 6);
  assert.equal(plan.totals.quarts, 0);
  assert.equal(plan.totals.gallons, 0);
});

test("D: a detail color whose total fits in a sample uses 1 sample", () => {
  const catalog = buildCheapQuartsCatalog();
  const plan = suggestContainersForColors(
    {
      brandId: "fixture_cheap_qt",
      areaSqFt: 80,
      coats: 1,
      wasteFactor: 0,
      colors: [{ id: "detail", coveragePercent: 10 }]
    },
    catalog
  );
  // requiredGallons = (80 * 0.10 * 1) / 400 = 0.02 → < 1/16 gallon, fits in 1 sample.
  const entry = plan.perColor[0]!;
  assert.equal(entry.packages.length, 1);
  assert.equal(entry.packages[0]!.unit, "sample");
  assert.equal(entry.packages[0]!.count, 1);
});

test("per-color coats override: one color with more coats needs more paint than its siblings", () => {
  const catalog = buildExpensiveQuartsCatalog();
  const plan = suggestContainersForColors(
    {
      brandId: "fixture_expensive_qt",
      areaSqFt: 1000,
      coats: 2,
      wasteFactor: 0,
      colors: [
        { id: "default_coats", coveragePercent: 25 },
        { id: "extra_coats", coveragePercent: 25, coats: 4 }
      ]
    },
    catalog
  );

  const defaultEntry = plan.perColor.find((entry) => entry.colorId === "default_coats")!;
  const extraEntry = plan.perColor.find((entry) => entry.colorId === "extra_coats")!;
  assert.equal(defaultEntry.coats, 2);
  assert.equal(extraEntry.coats, 4);
  assert.ok(
    extraEntry.requiredGallons > defaultEntry.requiredGallons * 1.9,
    `expected extra-coats color to roughly double the gallons of the default-coats color`
  );
});

test("per-color coats: zero or negative coats throws", () => {
  const catalog = buildExpensiveQuartsCatalog();
  assert.throws(
    () =>
      suggestContainersForColors(
        {
          brandId: "fixture_expensive_qt",
          areaSqFt: 1000,
          coats: 2,
          wasteFactor: 0,
          colors: [{ id: "bad", coveragePercent: 25, coats: 0 }]
        },
        catalog
      ),
    /coats must be greater than zero/
  );
});

test("D: sample regime skipped when sample price is not cheaper than a quart", () => {
  const catalog = buildSampleNotCheaperCatalog();
  const plan = suggestContainersForColors(
    {
      brandId: "fixture_sample_pricey",
      areaSqFt: 80,
      coats: 1,
      wasteFactor: 0,
      colors: [{ id: "detail", coveragePercent: 10 }]
    },
    catalog
  );
  // Same tiny required gallons as the test above, but sample price >= quart
  // price here, so D defers to the quart-minimum baseline (E).
  const entry = plan.perColor[0]!;
  assert.equal(entry.packages.length, 1);
  assert.equal(entry.packages[0]!.unit, "quart");
  assert.equal(entry.packages[0]!.count, 1);
});

function buildSampleNotCheaperCatalog(): PaintBrandCatalog {
  return {
    version: 1,
    units: { coverage: "sqft_per_gallon", price: "usd_per_unit" },
    brands: [
      {
        id: "fixture_sample_pricey",
        display_name: "Fixture Sample Not Cheaper",
        retailer: "Test",
        coverage: { min: 400, default: 400, max: 400 },
        default_coats: 2,
        confidence: "fixture",
        notes: "Fixture where sample price is not cheaper than a quart.",
        sources: [],
        prices: { currency: "USD", sample: 10, quart: 8, gallon: 30 },
        finishes: [{ id: "flat", display_name: "Flat", coverage_multiplier: 1.0 }]
      }
    ]
  };
}

function buildCheapQuartsCatalog(): PaintBrandCatalog {
  return {
    version: 1,
    units: { coverage: "sqft_per_gallon", price: "usd_per_unit" },
    brands: [
      {
        id: "fixture_cheap_qt",
        display_name: "Fixture Cheap Quarts",
        retailer: "Test",
        coverage: { min: 400, default: 400, max: 400 },
        default_coats: 2,
        confidence: "fixture",
        notes: "Fixture where 4 quarts cost less than one gallon.",
        sources: [],
        prices: { currency: "USD", sample: 3, quart: 5, gallon: 50 },
        finishes: [{ id: "flat", display_name: "Flat", coverage_multiplier: 1.0 }]
      }
    ]
  };
}

function buildExpensiveQuartsCatalog(): PaintBrandCatalog {
  return {
    version: 1,
    units: { coverage: "sqft_per_gallon", price: "usd_per_unit" },
    brands: [
      {
        id: "fixture_expensive_qt",
        display_name: "Fixture Expensive Quarts",
        retailer: "Test",
        coverage: { min: 400, default: 400, max: 400 },
        default_coats: 2,
        confidence: "fixture",
        notes: "Fixture where quarts are disproportionately expensive vs gallons.",
        sources: [],
        prices: { currency: "USD", sample: 6, quart: 14, gallon: 30 },
        finishes: [{ id: "flat", display_name: "Flat", coverage_multiplier: 1.0 }]
      }
    ]
  };
}
