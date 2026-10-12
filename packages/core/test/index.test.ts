import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import spectral from "spectral.js";
import type { PaintBrandCatalog } from "@muralist/config";
import { loadPaintBrandCatalog } from "@muralist/config";
import {
  applyClassification,
  applyMixesToCoverage,
  buildMaquetteFileName,
  classifyPaletteColors,
  compareAspectRatios,
  deriveColorAreaEstimates,
  deriveGridSpec,
  estimatePaintRequirement,
  getAuthCapabilities,
  rgbToOklab,
  suggestContainersForColors
} from "../src/index.js";
import type { ClassifyPaletteInput } from "../src/index.js";

test("guest mode cannot persist data", () => {
  const auth = getAuthCapabilities();

  assert.equal(auth.mode, "oauth_only");
  assert.equal(auth.guest.canPersistData, false);
});

test("scaled grid derives full cells and partial wall edges from mural dimensions", () => {
  const grid = deriveGridSpec({ widthFt: 17, heightFt: 9 }, 4);

  assert.deepEqual(grid, {
    cellSizeFt: 4,
    columns: 5,
    rows: 3,
    cellAreaSqFt: 16,
    hasPartialColumn: true,
    hasPartialRow: true,
    finalColumnWidthFt: 1,
    finalRowHeightFt: 1
  });
});

test("scaled grid keeps exact wall divisions as full edge cells", () => {
  const grid = deriveGridSpec({ widthFt: 20, heightFt: 12 }, 2);

  assert.equal(grid.columns, 10);
  assert.equal(grid.rows, 6);
  assert.equal(grid.hasPartialColumn, false);
  assert.equal(grid.hasPartialRow, false);
  assert.equal(grid.finalColumnWidthFt, 2);
  assert.equal(grid.finalRowHeightFt, 2);
});

test("scaled grid rejects invalid wall dimensions and cell sizes", () => {
  assert.throws(
    () => deriveGridSpec({ widthFt: 0, heightFt: 12 }, 2),
    /Wall width must be greater than zero/
  );
  assert.throws(
    () => deriveGridSpec({ widthFt: 20, heightFt: -1 }, 2),
    /Wall height must be greater than zero/
  );
  assert.throws(
    () => deriveGridSpec({ widthFt: 20, heightFt: 12 }, 0),
    /Grid cell size must be greater than zero/
  );
});

test("aspect ratio report warns when uploaded artwork and wall dimensions clearly diverge", () => {
  const report = compareAspectRatios(
    { widthPx: 400, heightPx: 300 },
    { widthFt: 16, heightFt: 4 }
  );

  assert.equal(report.sourceAspectRatio, 4 / 3);
  assert.equal(report.wallAspectRatio, 4);
  assert.equal(report.ratioDelta, 3);
  assert.equal(report.shouldWarn, true);
});

test("aspect ratio report does not warn for close source and wall ratios", () => {
  const report = compareAspectRatios(
    { widthPx: 1600, heightPx: 900 },
    { widthFt: 16, heightFt: 9.1 }
  );

  assert.equal(report.shouldWarn, false);
});

test("color area estimates convert palette coverage into mural square footage", () => {
  const estimates = deriveColorAreaEstimates(1200, [
    { id: "background", coveragePercent: 50 },
    { id: "detail", coveragePercent: 12.5 }
  ]);

  assert.deepEqual(estimates, [
    { id: "background", coveragePercent: 50, areaSqFt: 600 },
    { id: "detail", coveragePercent: 12.5, areaSqFt: 150 }
  ]);
});

test("color area estimates reject negative coverage", () => {
  assert.throws(
    () => deriveColorAreaEstimates(1200, [{ id: "bad", coveragePercent: -1 }]),
    /coveragePercent must be zero or greater/
  );
});

test("maquette file name appends suffix to the uploaded artwork name", () => {
  assert.equal(
    buildMaquetteFileName("winding-path-9840681_640.jpg"),
    "winding-path-9840681_640_maquette"
  );
});

test("maquette file name strips paths and unsafe characters", () => {
  assert.equal(
    buildMaquetteFileName("C:\\murals\\Dragon Tiger concept!!.png"),
    "Dragon_Tiger_concept_maquette"
  );
});

test("maquette file name falls back when the upload name is empty", () => {
  assert.equal(buildMaquetteFileName("   "), "muralist_maquette");
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

test("estimated cost per color equals the sum of its package line prices", () => {
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
  // requiredGallons ≈ 1.5 → 1 gallon ($50) + 2 quarts ($5 each) = $60
  const entry = plan.perColor[0]!;
  assert.equal(entry.estimatedCost, 60);
  assert.equal(plan.totals.estimatedCost, 60);
  assert.equal(plan.currency, "USD");
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

test("classifyPaletteColors collapses an even red-blue gradient to its two endpoints", () => {
  const steps = 10;
  const colors: ClassifyPaletteInput[] = [];
  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    colors.push({
      id: `step-${i}`,
      rgb: [Math.round(255 * (1 - t)), 0, Math.round(255 * t)],
      pixelCount: 100
    });
  }

  const classifications = classifyPaletteColors(colors, {
    residualThreshold: 0.04,
    mixCoveragePercent: 50
  });

  const buyIds = classifications.filter((entry) => entry.classification === "buy").map((entry) => entry.id);
  const absorbIds = classifications.filter((entry) => entry.classification === "absorb").map((entry) => entry.id);

  // Endpoints survive as buy, every middle step dissolves. Each step is 10% of
  // coverage, so mixCoveragePercent of 50 pushes every gradient middle to
  // absorb rather than mix.
  assert.equal(buyIds.length, 2);
  assert.ok(buyIds.includes("step-0"));
  assert.ok(buyIds.includes(`step-${steps - 1}`));
  assert.equal(absorbIds.length, steps - 2);
});

test("classifyPaletteColors keeps a dominant mid-gradient color as a mix with a 50/50 recipe", () => {
  const colors: ClassifyPaletteInput[] = [
    { id: "red", rgb: [255, 0, 0], pixelCount: 30 },
    { id: "blue", rgb: [0, 0, 255], pixelCount: 30 },
    { id: "purple", rgb: [128, 0, 128], pixelCount: 40 }
  ];

  // Purple's 40% would make it a dominant (always-buy) color under the
  // default 15% cutoff. This test is about the mix recipe itself, so the
  // dominant cutoff is raised above every color's coverage.
  const classifications = classifyPaletteColors(colors, {
    residualThreshold: 0.04,
    mixCoveragePercent: 5,
    dominantCoveragePercent: 50
  });

  const classByMap = new Map(classifications.map((entry) => [entry.id, entry]));
  assert.equal(classByMap.get("red")?.classification, "buy");
  assert.equal(classByMap.get("blue")?.classification, "buy");
  // Variant B pigment veto: #800080 is the sRGB midpoint of red and blue, but
  // red + blue paint (spectral.js) mixes to a much darker purple, so the
  // pigment curve misses it. An sRGB-only fit may not produce a recipe and
  // purple covers 40% (>= mixCoveragePercent), so it is bought.
  // (Was: purple is a mix with a 50/50 recipe.)
  assert.equal(classByMap.get("purple")?.classification, "buy");

  // The same dominant-mid case with the purple paint actually makes: equal
  // parts red and blue through spectral.js is a mix with a 50/50 recipe.
  const pigmentPurple = spectral
    .mix([new spectral.Color("#FF0000"), 0.5], [new spectral.Color("#0000FF"), 0.5])
    .toString()
    .toUpperCase();
  const pigmentClassifications = classifyPaletteColors(
    [colors[0]!, colors[1]!, { id: "purple", rgb: hexToRgb(pigmentPurple), pixelCount: 40 }],
    { residualThreshold: 0.04, mixCoveragePercent: 5, dominantCoveragePercent: 50 }
  );
  const purple = pigmentClassifications.find((entry) => entry.id === "purple");
  assert.equal(purple?.classification, "mix");
  assert.ok(purple?.recipe);
  const fractionsById = Object.fromEntries(
    (purple!.recipe!.components).map((component) => [component.colorId, component.fraction])
  );
  assert.ok(Math.abs((fractionsById.red ?? 0) - 0.5) < 0.05);
  assert.ok(Math.abs((fractionsById.blue ?? 0) - 0.5) < 0.05);
});

test("classifyPaletteColors keeps three independent primaries all as buy", () => {
  const classifications = classifyPaletteColors(
    [
      { id: "red", rgb: [220, 20, 20], pixelCount: 100 },
      { id: "green", rgb: [20, 220, 20], pixelCount: 100 },
      { id: "blue", rgb: [20, 20, 220], pixelCount: 100 }
    ],
    { residualThreshold: 0.04, mixCoveragePercent: 5 }
  );

  assert.equal(classifications.filter((entry) => entry.classification === "buy").length, 3);
});

test("classifyPaletteColors keeps a lone off-line accent as buy", () => {
  const classifications = classifyPaletteColors(
    [
      { id: "red", rgb: [220, 20, 20], pixelCount: 500 },
      { id: "blue", rgb: [20, 20, 220], pixelCount: 500 },
      { id: "accent", rgb: [250, 180, 30], pixelCount: 5 }
    ],
    { residualThreshold: 0.04, mixCoveragePercent: 5 }
  );

  const accent = classifications.find((entry) => entry.id === "accent");
  assert.equal(accent?.classification, "buy");
});

test("classifyPaletteColors resolves transitive absorb chains across dedup and gradient passes", () => {
  // Two clusters along a mixing line. Each cluster has a dedup pair (tight
  // Euclidean neighbors). The cluster centroids lie on a segment with a
  // mid-gradient color in between. Mid's coverage is below the mix threshold
  // so it should absorb into the cluster it is nearest to. The dedup pair
  // inside the target cluster was routed to a color that Phase 2 then also
  // absorbs — without path compression the final pointers would reference
  // a no-longer-surviving keeper.
  const colors: ClassifyPaletteInput[] = [
    { id: "red-main", rgb: [210, 40, 40], pixelCount: 100 },
    { id: "red-near", rgb: [214, 44, 43], pixelCount: 20 },
    { id: "blue-main", rgb: [40, 40, 210], pixelCount: 90 },
    { id: "blue-near", rgb: [36, 43, 213], pixelCount: 15 },
    { id: "mid", rgb: [125, 40, 125], pixelCount: 8 }
  ];
  const classifications = classifyPaletteColors(colors, {
    residualThreshold: 0.05,
    mixCoveragePercent: 10
  });
  // Every absorb must point at a buy so applyClassification can fold safely.
  const buyIds = new Set(
    classifications.filter((entry) => entry.classification === "buy").map((entry) => entry.id)
  );
  for (const entry of classifications) {
    if (entry.classification !== "absorb") continue;
    assert.ok(
      entry.absorbedIntoId && buyIds.has(entry.absorbedIntoId),
      `${entry.id} should absorb into a buy color, not ${entry.absorbedIntoId}`
    );
  }
  // And applyClassification should not throw on the chain.
  assert.doesNotThrow(() => applyClassification(colors, classifications));
});

test("classifyPaletteColors deduplicates near-neighbors even when no mixing line exists", () => {
  // Two tight clusters plus a distant outlier. No color is on a line between
  // others, but each cluster has near-duplicate members that should collapse.
  const colors: ClassifyPaletteInput[] = [
    { id: "cluster-a-1", rgb: [200, 30, 30], pixelCount: 100 },
    { id: "cluster-a-2", rgb: [205, 35, 32], pixelCount: 20 },
    { id: "cluster-b-1", rgb: [30, 30, 200], pixelCount: 80 },
    { id: "cluster-b-2", rgb: [34, 28, 198], pixelCount: 15 },
    { id: "outlier", rgb: [40, 200, 40], pixelCount: 60 }
  ];
  const classifications = classifyPaletteColors(colors, {
    residualThreshold: 0.05,
    mixCoveragePercent: 5
  });
  const classByMap = new Map(classifications.map((entry) => [entry.id, entry]));

  // Near-duplicates absorb into the higher-coverage keeper of their cluster.
  assert.equal(classByMap.get("cluster-a-2")?.classification, "absorb");
  assert.equal(classByMap.get("cluster-a-2")?.absorbedIntoId, "cluster-a-1");
  assert.equal(classByMap.get("cluster-b-2")?.classification, "absorb");
  assert.equal(classByMap.get("cluster-b-2")?.absorbedIntoId, "cluster-b-1");
  // Remaining three are all independent buys.
  assert.equal(classByMap.get("cluster-a-1")?.classification, "buy");
  assert.equal(classByMap.get("cluster-b-1")?.classification, "buy");
  assert.equal(classByMap.get("outlier")?.classification, "buy");
});

test("classifyPaletteColors with fewer than three colors marks every entry as buy", () => {
  const classifications = classifyPaletteColors(
    [
      { id: "a", rgb: [0, 0, 0], pixelCount: 50 },
      { id: "b", rgb: [255, 255, 255], pixelCount: 50 }
    ],
    { residualThreshold: 0.04, mixCoveragePercent: 5 }
  );

  assert.deepEqual(
    classifications.map((entry) => entry.classification),
    ["buy", "buy"]
  );
});

test("classifyPaletteColors rejects invalid options", () => {
  const colors: ClassifyPaletteInput[] = [
    { id: "a", rgb: [10, 10, 10], pixelCount: 1 },
    { id: "b", rgb: [250, 250, 250], pixelCount: 1 }
  ];
  assert.throws(
    () => classifyPaletteColors(colors, { residualThreshold: 0, mixCoveragePercent: 5 }),
    /Residual threshold must be greater than zero/
  );
  assert.throws(
    () => classifyPaletteColors(colors, { residualThreshold: 10, mixCoveragePercent: -1 }),
    /Mix coverage percent must be zero or greater/
  );
});

// The web app's Conservative / Balanced / Aggressive presets (OKLab units),
// mirrored from SENSITIVITY_PRESETS in apps/web/app/PrototypeApp.tsx.
const OKLAB_PRESETS = [0.02, 0.04, 0.07];

// Recipe fractions are rounded to 4 decimals, which moves the mix by far
// less than this.
const RECIPE_EPSILON = 1e-3;

/** Linear-light RGB (0-1) to OKLab via unrounded sRGB, clamped like core. */
function linearToOklab(linear: readonly number[]): [number, number, number] {
  const toSrgb = (value: number) => {
    const c = Math.min(1, Math.max(0, value));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  };
  return rgbToOklab([toSrgb(linear[0]!), toSrgb(linear[1]!), toSrgb(linear[2]!)]);
}

/**
 * OKLab distance between a recipe's target and what spectral.js says its
 * components make when mixed at the recipe's fractions (parts of paint).
 */
function recipeMiss(
  recipe: { targetColorId: string; components: { colorId: string; fraction: number }[] },
  colors: ClassifyPaletteInput[]
): number {
  const rgbOf = (id: string) => colors.find((color) => color.id === id)!.rgb;
  const mixed = spectral.mix(
    ...recipe.components.map(
      (component) =>
        [new spectral.Color([...rgbOf(component.colorId)]), component.fraction] as [
          InstanceType<typeof spectral.Color>,
          number
        ]
    )
  );
  const target = rgbToOklab(rgbOf(recipe.targetColorId));
  const made = linearToOklab(mixed.lRGB);
  return Math.hypot(target[0] - made[0], target[1] - made[1], target[2] - made[2]);
}

function oklabChroma(hex: string): number {
  const [, a, b] = rgbToOklab(hexToRgb(hex));
  return Math.hypot(a, b);
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [
    number,
    number,
    number
  ];
}

function paletteFromHexCoverage(entries: [string, number][]): ClassifyPaletteInput[] {
  return entries.map(([hex, coverage]) => ({
    id: hex,
    rgb: hexToRgb(hex),
    pixelCount: Math.round(coverage * 10)
  }));
}

function assertCoherent(classifications: ReturnType<typeof classifyPaletteColors>) {
  const buyIds = new Set(
    classifications.filter((entry) => entry.classification === "buy").map((entry) => entry.id)
  );
  for (const entry of classifications) {
    if (entry.classification === "mix") {
      for (const component of entry.recipe!.components) {
        assert.ok(buyIds.has(component.colorId), `${entry.id} mixes from non-buy ${component.colorId}`);
      }
    }
    if (entry.classification === "absorb") {
      assert.ok(
        entry.absorbedIntoId && buyIds.has(entry.absorbedIntoId),
        `${entry.id} absorbs into non-buy ${entry.absorbedIntoId}`
      );
    }
  }
}

test("rgbToOklab maps white and black to the ends of the lightness axis", () => {
  const white = rgbToOklab([255, 255, 255]);
  const black = rgbToOklab([0, 0, 0]);
  assert.ok(Math.abs(white[0] - 1) < 1e-3 && Math.abs(white[1]) < 1e-3 && Math.abs(white[2]) < 1e-3);
  assert.ok(Math.abs(black[0]) < 1e-9 && Math.abs(black[1]) < 1e-9 && Math.abs(black[2]) < 1e-9);
});

test("classifyPaletteColors never makes the feedback teal palette's teal or purple from white + black", () => {
  // "Mixing Issues 9/16/26" palette: light teal came back as 74% white + 26%
  // near-black and the purple as white + near-black.
  const colors = paletteFromHexCoverage([
    ["#FFFFFF", 50.7],
    ["#92D8D7", 21.4],
    ["#038D8C", 8.9],
    ["#390E5D", 6.9],
    ["#FAD678", 6.0],
    ["#020F1A", 3.3],
    ["#3BB5B2", 2.7],
    ["#C1A76C", 0.1]
  ]);
  const whiteOrBlack = new Set(["#FFFFFF", "#020F1A"]);
  for (const residualThreshold of OKLAB_PRESETS) {
    for (const mixCoveragePercent of [0, 5]) {
      // 100 disables the dominant-color rule so the mix fit itself is tested.
      for (const dominantCoveragePercent of [15, 100]) {
        const classifications = classifyPaletteColors(colors, {
          residualThreshold,
          mixCoveragePercent,
          dominantCoveragePercent
        });
        const byId = new Map(classifications.map((entry) => [entry.id, entry]));
        const label = `threshold ${residualThreshold}, mix ${mixCoveragePercent}%, dominant ${dominantCoveragePercent}%`;
        for (const id of ["#92D8D7", "#390E5D"]) {
          const entry = byId.get(id)!;
          if (entry.classification === "mix") {
            const partners = entry.recipe!.components.map((component) => component.colorId);
            assert.ok(
              !partners.every((partner) => whiteOrBlack.has(partner)),
              `${id} is a white/black mix at ${label}`
            );
          }
        }
        // Under the default dominant cutoff the 21% light teal is a buy.
        if (dominantCoveragePercent === 15) {
          assert.equal(byId.get("#92D8D7")?.classification, "buy", label);
        }
        assertCoherent(classifications);
      }
    }
  }
});

test("classifyPaletteColors never mixes or absorbs a dominant color", () => {
  // "mid" is the exact sRGB midpoint of red and blue and covers 20%, so it
  // would be a perfect mix. "pinkish" sits a hair from red, so it would be a
  // near-duplicate absorb. Both cover >= 15% and must stay buy.
  const colors: ClassifyPaletteInput[] = [
    { id: "red", rgb: [220, 20, 20], pixelCount: 300 },
    { id: "blue", rgb: [20, 20, 220], pixelCount: 300 },
    { id: "mid", rgb: [120, 20, 120], pixelCount: 200 },
    { id: "pinkish", rgb: [222, 22, 24], pixelCount: 200 }
  ];
  for (const residualThreshold of OKLAB_PRESETS) {
    const classifications = classifyPaletteColors(colors, {
      residualThreshold,
      mixCoveragePercent: 5
    });
    for (const entry of classifications) {
      assert.equal(entry.classification, "buy", `${entry.id} at ${residualThreshold}`);
    }
  }

  // Lowering the cutoff below their coverage is what lets them collapse.
  const relaxed = classifyPaletteColors(colors, {
    residualThreshold: 0.04,
    mixCoveragePercent: 5,
    dominantCoveragePercent: 50
  });
  const relaxedById = new Map(relaxed.map((entry) => [entry.id, entry]));
  // Variant B pigment veto: "mid" is only on the sRGB line (red + blue paint
  // is far darker), and at 20% it is above mixCoveragePercent, so it is
  // bought rather than given a recipe paint cannot produce. (Was: "mix".)
  assert.equal(relaxedById.get("mid")?.classification, "buy");
  assert.equal(relaxedById.get("pinkish")?.classification, "absorb");

  // With the purple red + blue paint really makes in its place, lowering
  // the dominant cutoff does let it collapse to a mix.
  const pigmentMid = spectral
    .mix([new spectral.Color([220, 20, 20]), 0.5], [new spectral.Color([20, 20, 220]), 0.5])
    .toString()
    .toUpperCase();
  const pigmentRelaxed = classifyPaletteColors(
    colors.map((color) => (color.id === "mid" ? { ...color, rgb: hexToRgb(pigmentMid) } : color)),
    { residualThreshold: 0.04, mixCoveragePercent: 5, dominantCoveragePercent: 50 }
  );
  assert.equal(pigmentRelaxed.find((entry) => entry.id === "mid")?.classification, "mix");
});

test("classifyPaletteColors only gives synthetic sRGB gradient steps recipes paint can make", () => {
  // Rows from feedback/ColorMixSamples(Sheet1).csv: 100/0, 80/20, 60/40,
  // 40/60, 20/80, 0/100 sRGB blends of two colors.
  const rows: string[][] = [
    ["#E417A5", "#BC1AA6", "#941DA6", "#6C1FA7", "#4422A7", "#1C25A8"],
    ["#F27032", "#F58D5B", "#F7A984", "#FAC6AD", "#FCE2D6", "#FFFFFF"],
    ["#DF0D0D", "#BF2D31", "#9F4D54", "#7F6E78", "#5F8E9B", "#3FAEBF"]
  ];
  for (const row of rows) {
    const colors = paletteFromHexCoverage(
      row.map((hex, index) => [hex, index === 0 || index === row.length - 1 ? 30 : 10])
    );
    for (const residualThreshold of OKLAB_PRESETS) {
      const classifications = classifyPaletteColors(colors, {
        residualThreshold,
        mixCoveragePercent: 5
      });
      const byId = new Map(classifications.map((entry) => [entry.id, entry]));
      const first = row[0]!;
      const last = row[row.length - 1]!;
      assert.equal(byId.get(first)?.classification, "buy");
      assert.equal(byId.get(last)?.classification, "buy");
      row.slice(1, -1).forEach((hex, index) => {
        const entry = byId.get(hex)!;
        // Looser presets may fold a step next to an endpoint in as a near
        // duplicate; that still collapses the gradient onto its endpoints.
        // At the conservative preset every step must keep its recipe.
        if (entry.classification === "absorb" && residualThreshold > OKLAB_PRESETS[0]!) {
          assert.ok([first, last].includes(entry.absorbedIntoId!), `${hex} absorbs into an endpoint`);
          return;
        }
        // Variant B pigment veto. These rows are sRGB lerps, not paint. A
        // step the pigment curve between its endpoints misses is bought
        // (each step covers 10%, above mixCoveragePercent); a step it fits
        // is a mix whose recipe, in parts of paint, reproduces the step.
        // (Was: every step is a mix with the sRGB 80/20 ... 20/80 fractions;
        // those are sRGB interpolation weights, not parts of paint.)
        if (entry.classification === "buy") return;
        assert.equal(entry.classification, "mix", `${hex} at ${residualThreshold}`);
        // A step the endpoints' pigment curve misses is bought and can then
        // partner a neighbouring step, so partners are any buys in the row.
        assert.ok(
          entry.recipe!.components.every((component) => row.includes(component.colorId)),
          `${hex} partners outside its row`
        );
        assert.ok(
          recipeMiss(entry.recipe!, colors) <= residualThreshold + RECIPE_EPSILON,
          `${hex} recipe misses by ${recipeMiss(entry.recipe!, colors)} at ${residualThreshold}`
        );
      });
    }
  }
});

test("classifyPaletteColors lets two colors that bracket each other both serve as mix partners", () => {
  // #3BB5B2 sits between white and #038D8C, and #038D8C sits between #3BB5B2
  // and near-black. The old classifier let each teal disqualify the other as
  // a partner, so the light teal fell back to white + near-black.
  const colors = paletteFromHexCoverage([
    ["#FFFFFF", 40],
    ["#038D8C", 14],
    ["#3BB5B2", 12],
    ["#020F1A", 10],
    ["#92D8D7", 8],
    ["#FAD678", 6]
  ]);
  for (const residualThreshold of OKLAB_PRESETS) {
    const classifications = classifyPaletteColors(colors, {
      residualThreshold,
      mixCoveragePercent: 0
    });
    assertCoherent(classifications);
    const lightTeal = classifications.find((entry) => entry.id === "#92D8D7")!;
    // Variant B pigment veto: at 0.02 the white + #038D8C pigment curve
    // misses the light teal by more than the threshold, and the sRGB-line
    // fit through the mid teal (itself a mix, so not a partner) cannot
    // produce a recipe; at 8% it is bought. (Was: a mix at every preset.)
    if (residualThreshold === 0.02) {
      assert.equal(lightTeal.classification, "buy", `at ${residualThreshold}`);
      continue;
    }
    assert.equal(lightTeal.classification, "mix", `at ${residualThreshold}`);
    const partners = lightTeal.recipe!.components.map((component) => component.colorId);
    assert.ok(partners.includes("#FFFFFF"));
    assert.ok(
      partners.includes("#3BB5B2") || partners.includes("#038D8C"),
      `light teal mixes from ${partners.join(" + ")} at ${residualThreshold}`
    );
    assert.ok(!partners.includes("#020F1A"));
  }

  // At the conservative preset the deep teal stays buy. Variant B: on the
  // pigment curve #3BB5B2 is itself a white tint of #038D8C (spectral.js
  // puts 60% #038D8C + 40% white at #33B5B4), so it is a mix rather than the
  // second buy teal the sRGB-only classifier needed, and both light teals
  // come from white + the deep teal.
  const conservative = classifyPaletteColors(colors, {
    residualThreshold: 0.02,
    mixCoveragePercent: 0
  });
  const byId = new Map(conservative.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("#038D8C")?.classification, "buy");
  assert.equal(byId.get("#3BB5B2")?.classification, "mix");
  const midTeal = Object.fromEntries(
    byId.get("#3BB5B2")!.recipe!.components.map((component) => [component.colorId, component.fraction])
  );
  assert.deepEqual(Object.keys(midTeal).sort(), ["#038D8C", "#FFFFFF"]);
  assert.ok(Math.abs(midTeal["#038D8C"]! - 0.6) < 0.05, `#038D8C share ${midTeal["#038D8C"]}`);
  // Pigment veto (see above): the light teal is bought at 0.02. (Was: mixed
  // from white + #038D8C.) At 0.04 it is that white tint of the deep teal.
  assert.equal(byId.get("#92D8D7")?.classification, "buy");
  const standard = classifyPaletteColors(colors, { residualThreshold: 0.04, mixCoveragePercent: 0 });
  assert.deepEqual(
    standard
      .find((entry) => entry.id === "#92D8D7")!
      .recipe!.components.map((component) => component.colorId)
      .sort(),
    ["#038D8C", "#FFFFFF"]
  );
});

test("classifyPaletteColors does not pick a much rarer color as a mix partner", () => {
  // "mid" lies between white and a 1% accent. It covers 8%, so mixing it
  // from the accent would mean buying the accent mostly for mid's sake.
  const colors: ClassifyPaletteInput[] = [
    { id: "white", rgb: [255, 255, 255], pixelCount: 600 },
    { id: "mid", rgb: [170, 170, 230], pixelCount: 80 },
    { id: "other", rgb: [200, 60, 40], pixelCount: 300 },
    { id: "accent", rgb: [85, 85, 205], pixelCount: 10 }
  ];
  const classifications = classifyPaletteColors(colors, {
    residualThreshold: 0.04,
    mixCoveragePercent: 5
  });
  const byId = new Map(classifications.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("mid")?.classification, "buy");
  assert.equal(byId.get("accent")?.classification, "buy");
});

test("classifyPaletteColors detects a pigment-mix gradient that leaves the sRGB line", () => {
  // Blue + yellow paint mixed with spectral.js (Kubelka-Munk) goes through
  // green; the sRGB line between them goes through gray. Steps at 20/40/60/80
  // parts yellow.
  const blue = new spectral.Color("#002185");
  const yellow = new spectral.Color("#FCD200");
  const shares = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const row = shares.map((share) =>
    share === 0 ? "#002185" : share === 1 ? "#FCD200" : spectral.mix([blue, 1 - share], [yellow, share]).toString().toUpperCase()
  );
  assert.equal(new Set(row).size, row.length);

  // Sanity: the middle steps are far off the sRGB line, so only the pigment
  // path can explain them.
  const [b0, b1, b2] = hexToRgb("#002185");
  const [y0, y1, y2] = hexToRgb("#FCD200");
  for (const hex of row.slice(2, -2)) {
    const lab = rgbToOklab(hexToRgb(hex));
    let closest = Infinity;
    for (let step = 0; step <= 1000; step += 1) {
      const t = step / 1000;
      const point = rgbToOklab([b0 + t * (y0 - b0), b1 + t * (y1 - b1), b2 + t * (y2 - b2)]);
      closest = Math.min(closest, Math.hypot(lab[0] - point[0], lab[1] - point[1], lab[2] - point[2]));
    }
    assert.ok(closest > 0.07, `${hex} is ${closest} from the sRGB line`);
  }

  const colors = paletteFromHexCoverage(
    row.map((hex, index) => [hex, index === 0 || index === row.length - 1 ? 30 : 10])
  );
  const first = row[0]!;
  const last = row[row.length - 1]!;
  for (const residualThreshold of OKLAB_PRESETS) {
    const classifications = classifyPaletteColors(colors, {
      residualThreshold,
      mixCoveragePercent: 5
    });
    assertCoherent(classifications);
    const byId = new Map(classifications.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(first)?.classification, "buy");
    assert.equal(byId.get(last)?.classification, "buy");
    row.slice(1, -1).forEach((hex, index) => {
      const entry = byId.get(hex)!;
      if (entry.classification === "absorb" && residualThreshold > OKLAB_PRESETS[0]!) {
        assert.ok([first, last].includes(entry.absorbedIntoId!), `${hex} absorbs into an endpoint`);
        return;
      }
      assert.equal(entry.classification, "mix", `${hex} at ${residualThreshold}`);
      const fractions = Object.fromEntries(
        entry.recipe!.components.map((component) => [component.colorId, component.fraction])
      );
      const expectedLast = shares[index + 1]!;
      assert.ok(Math.abs((fractions[last] ?? 0) - expectedLast) < 0.03, `${hex} yellow share ${fractions[last]}`);
      assert.ok(Math.abs((fractions[first] ?? 0) - (1 - expectedLast)) < 0.03, `${hex} blue share ${fractions[first]}`);
    });
  }
});

test("classifyPaletteColors never mixes a chromatic color from two neutrals", () => {
  // White + black (or any two grays) mixes to gray on both the sRGB line and
  // the pigment curve, so a recipe of two neutrals for a hued color is wrong.
  const palettes: [string, number][][] = [
    [
      ["#FFFFFF", 50.7],
      ["#92D8D7", 21.4],
      ["#038D8C", 8.9],
      ["#390E5D", 6.9],
      ["#FAD678", 6.0],
      ["#020F1A", 3.3],
      ["#3BB5B2", 2.7],
      ["#C1A76C", 0.1]
    ],
    [
      ["#FFFFFF", 30],
      ["#111111", 25],
      ["#808080", 12],
      ["#C03030", 10],
      ["#30A050", 10],
      ["#7030A0", 8],
      ["#4D4D4D", 5]
    ]
  ];
  const chroma = (hex: string) => {
    const [, a, b] = rgbToOklab(hexToRgb(hex));
    return Math.hypot(a, b);
  };
  for (const entries of palettes) {
    const colors = paletteFromHexCoverage(entries);
    for (const residualThreshold of OKLAB_PRESETS) {
      for (const dominantCoveragePercent of [15, 100]) {
        const classifications = classifyPaletteColors(colors, {
          residualThreshold,
          mixCoveragePercent: 0,
          dominantCoveragePercent
        });
        assertCoherent(classifications);
        for (const entry of classifications) {
          if (entry.classification !== "mix") continue;
          const partners = entry.recipe!.components.map((component) => component.colorId);
          if (partners.every((partner) => chroma(partner) < 0.02)) {
            assert.ok(
              chroma(entry.id) < 0.02 + residualThreshold,
              `${entry.id} mixed from neutrals ${partners.join(" + ")} at ${residualThreshold}`
            );
          }
        }
      }
    }
  }
});

test("applyClassification folds absorbed pixel counts into the keeper and surfaces mix recipes", () => {
  const colors: ClassifyPaletteInput[] = [
    { id: "red", rgb: [255, 0, 0], pixelCount: 40 },
    { id: "blue", rgb: [0, 0, 255], pixelCount: 30 },
    { id: "mid", rgb: [128, 0, 128], pixelCount: 20 },
    { id: "near-red", rgb: [200, 0, 50], pixelCount: 10 }
  ];
  const { nextColors, mixes, absorbedCount } = applyClassification(colors, [
    { id: "red", classification: "buy" },
    { id: "blue", classification: "buy" },
    {
      id: "mid",
      classification: "mix",
      recipe: {
        targetColorId: "mid",
        components: [
          { colorId: "red", fraction: 0.5 },
          { colorId: "blue", fraction: 0.5 }
        ]
      }
    },
    { id: "near-red", classification: "absorb", absorbedIntoId: "red" }
  ]);

  assert.equal(absorbedCount, 1);
  assert.equal(mixes.length, 1);
  assert.equal(mixes[0]!.targetColorId, "mid");
  const nextById = Object.fromEntries(nextColors.map((color) => [color.id, color.pixelCount]));
  assert.equal(nextById.red, 50); // 40 + 10 absorbed
  assert.equal(nextById.blue, 30);
  assert.equal(nextById.mid, 20); // mix stays in palette
  assert.ok(!("near-red" in nextById));
});

test("applyMixesToCoverage redistributes a mix's coverage to its components and drops the target", () => {
  const result = applyMixesToCoverage(
    [
      { id: "red", coveragePercent: 40 },
      { id: "blue", coveragePercent: 30 },
      { id: "purple", coveragePercent: 30 }
    ],
    [
      {
        targetColorId: "purple",
        components: [
          { colorId: "red", fraction: 0.4 },
          { colorId: "blue", fraction: 0.6 }
        ]
      }
    ]
  );

  const byId = Object.fromEntries(result.map((color) => [color.id, color.coveragePercent]));
  assert.equal(byId.red, 40 + 0.4 * 30);
  assert.equal(byId.blue, 30 + 0.6 * 30);
  assert.ok(!("purple" in byId));
  const totalAfter = result.reduce((sum, color) => sum + color.coveragePercent, 0);
  assert.ok(Math.abs(totalAfter - 100) < 1e-9);
});

test("applyMixesToCoverage rejects unknown component references and bad fraction sums", () => {
  assert.throws(
    () =>
      applyMixesToCoverage(
        [
          { id: "red", coveragePercent: 50 },
          { id: "blue", coveragePercent: 50 }
        ],
        [
          {
            targetColorId: "red",
            components: [
              { colorId: "red", fraction: 0.5 },
              { colorId: "mystery", fraction: 0.5 }
            ]
          }
        ]
      ),
    /Mix component mystery for red is not in the coverage list/
  );

  assert.throws(
    () =>
      applyMixesToCoverage(
        [
          { id: "red", coveragePercent: 50 },
          { id: "blue", coveragePercent: 50 }
        ],
        [
          {
            targetColorId: "red",
            components: [
              { colorId: "blue", fraction: 0.3 },
              { colorId: "red", fraction: 0.3 }
            ]
          }
        ]
      ),
    /expected 1.0/
  );
});

// feedback/ColorMixSamples(Sheet1).csv, copied as a fixture. Rows 1-2 are
// headers; each data row holds six hex colors (endpoint A, 80/20, 60/40,
// 40/60, 20/80, endpoint B) in columns 1-6 and a name in the last column.
// The steps are exact straight sRGB interpolations of the endpoints (max
// channel error 0.4 against a lerp), so they are ground truth for digital
// gradients — NOT physical paint mixes. Incomplete rows (the trailing
// "#FFFFFFF" row with no steps) are skipped.
type GradientFixture = { name: string; hexes: string[] };

function loadGradientFixtures(): GradientFixture[] {
  const csv = readFileSync(
    fileURLToPath(new URL("./fixtures/color-mix-samples.csv", import.meta.url)),
    "utf8"
  );
  const gradients: GradientFixture[] = [];
  for (const line of csv.split(/\r?\n/).slice(2)) {
    const cells = line.split(",").map((cell) => cell.trim());
    const hexes = cells.slice(0, 6);
    if (!hexes.every((hex) => /^#[0-9A-Fa-f]{6}$/.test(hex))) continue;
    gradients.push({ name: cells[cells.length - 1] ?? "", hexes: hexes.map((hex) => hex.toUpperCase()) });
  }
  return gradients;
}

test("classifyPaletteColors never absorbs into a near-duplicate keeper that became a mix", () => {
  // Low-chroma palette: #97938E is a mid greige on the line between the
  // off-white and the charcoal, and #9C9893 is its near-duplicate. Phase 0
  // folds #9C9893 into #97938E; with the dominant rule disabled #97938E is
  // then classified a mix, which used to leave #9C9893 absorbed into a color
  // nobody buys.
  const colors = paletteFromHexCoverage([
    ["#F2EFEA", 30],
    ["#3A3836", 20],
    ["#97938E", 18],
    ["#C4C0BA", 9],
    ["#6B6865", 8],
    ["#9C9893", 6],
    ["#5E5C5A", 3]
  ]);
  const classifications = classifyPaletteColors(colors, {
    residualThreshold: 0.07,
    mixCoveragePercent: 5,
    dominantCoveragePercent: 100
  });
  const byId = new Map(classifications.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("#97938E")?.classification, "mix");
  assert.equal(byId.get("#9C9893")?.classification, "absorb");
  assertCoherent(classifications);
});

test("classifyPaletteColors absorbs and mixes only into buy colors across presets and palettes", () => {
  const gradients = loadGradientFixtures();
  const palettes: Record<string, ClassifyPaletteInput[]> = {
    teal: paletteFromHexCoverage([
      ["#FFFFFF", 50.7],
      ["#92D8D7", 21.4],
      ["#038D8C", 8.9],
      ["#390E5D", 6.9],
      ["#FAD678", 6.0],
      ["#020F1A", 3.3],
      ["#3BB5B2", 2.7],
      ["#C1A76C", 0.1]
    ]),
    greige: paletteFromHexCoverage([
      ["#F2EFEA", 30],
      ["#3A3836", 20],
      ["#97938E", 18],
      ["#C4C0BA", 9],
      ["#6B6865", 8],
      ["#9C9893", 6],
      ["#5E5C5A", 3]
    ]),
    grays: paletteFromHexCoverage([
      ["#FFFFFF", 35],
      ["#000000", 25],
      ["#808080", 20],
      ["#404040", 6],
      ["#858585", 5],
      ["#C0C0C0", 5],
      ["#7B7B7B", 4]
    ]),
    clusters: [
      { id: "red-main", rgb: [210, 40, 40], pixelCount: 100 },
      { id: "red-near", rgb: [214, 44, 43], pixelCount: 20 },
      { id: "blue-main", rgb: [40, 40, 210], pixelCount: 90 },
      { id: "blue-near", rgb: [36, 43, 213], pixelCount: 15 },
      { id: "mid", rgb: [125, 40, 125], pixelCount: 8 }
    ],
    gradients: gradientPalette(gradients.slice(0, 4))
  };
  for (const [name, colors] of Object.entries(palettes)) {
    for (const residualThreshold of OKLAB_PRESETS) {
      for (const mixCoveragePercent of [0, 5]) {
        for (const dominantCoveragePercent of [15, 100]) {
          const classifications = classifyPaletteColors(colors, {
            residualThreshold,
            mixCoveragePercent,
            dominantCoveragePercent
          });
          assertCoherent(classifications);
          assert.doesNotThrow(() => applyClassification(colors, classifications));
        }
      }
    }
  }
});

// Endpoints 3000 px each, interior steps 600 px each; shared hexes across
// gradients are deduped with their pixels summed.
function gradientPalette(gradients: GradientFixture[]): ClassifyPaletteInput[] {
  const pixelsById = new Map<string, number>();
  for (const { hexes } of gradients) {
    hexes.forEach((hex, index) => {
      const pixels = index === 0 || index === hexes.length - 1 ? 3000 : 600;
      pixelsById.set(hex, (pixelsById.get(hex) ?? 0) + pixels);
    });
  }
  return [...pixelsById].map(([hex, pixelCount]) => ({ id: hex, rgb: hexToRgb(hex), pixelCount }));
}

test("classifyPaletteColors gives CSV fixture gradient steps only pigment-consistent recipes from their endpoints", () => {
  // Variant B pigment veto. The CSV steps are sRGB lerps; paint does not mix
  // along that line. Each interior step, classified with only its own
  // gradient, is a mix of the two endpoints whose spectral.js reconstruction
  // at the recipe's parts lands within the threshold (partners: buys from
  // the same gradient, normally the endpoints), absorbed within its
  // gradient, or buy (the pigment curve misses it, or it is dominant).
  // (Was: every step is a mix of its endpoints with the sRGB 80/20 ... 20/80
  // fractions, buy only when dominant; those fractions are interpolation
  // weights, not parts of paint, and a step paint cannot reach is now buy.)
  // Recipes at dominant 15% (84 steps): 0.02 -> 53, 0.04 -> 71, 0.07 -> 53.
  const gradients = loadGradientFixtures();
  assert.equal(gradients.length, 21);
  const tintRows = new Set(["White to black", "Indigo to white", "Cyan to White", "Orange to white"]);
  for (const residualThreshold of OKLAB_PRESETS) {
    for (const dominantCoveragePercent of [15, 100]) {
      for (const { name, hexes } of gradients) {
        const colors = gradientPalette([{ name, hexes }]);
        const endpointA = hexes[0]!;
        const endpointB = hexes[hexes.length - 1]!;
        const classifications = classifyPaletteColors(colors, {
          residualThreshold,
          mixCoveragePercent: 5,
          dominantCoveragePercent
        });
        assertCoherent(classifications);
        const byId = new Map(classifications.map((entry) => [entry.id, entry]));
        let recipes = 0;
        let endpointRecipes = 0;
        for (const hex of hexes.slice(1, -1)) {
          const entry = byId.get(hex)!;
          const label = `${name} ${hex} at ${residualThreshold}, dominant ${dominantCoveragePercent}%`;
          if (entry.classification === "buy") continue;
          if (entry.classification === "absorb") {
            assert.ok(hexes.includes(entry.absorbedIntoId!), `${label} absorbs outside its gradient`);
            continue;
          }
          recipes += 1;
          // Partners are the endpoints, or — when the endpoints' pigment
          // curve misses a step, so it is bought — that bought step and an
          // endpoint. Either way they are buys from this gradient.
          assert.ok(
            entry.recipe!.components.every((component) => hexes.includes(component.colorId)),
            `${label} partners outside its gradient`
          );
          if (
            [endpointA, endpointB].every((endpoint) =>
              entry.recipe!.components.some((component) => component.colorId === endpoint)
            )
          ) {
            endpointRecipes += 1;
          }
          const miss = recipeMiss(entry.recipe!, colors);
          assert.ok(miss <= residualThreshold + RECIPE_EPSILON, `${label} recipe misses by ${miss}`);
        }
        // White and black, and white tints of a color, mix close to the
        // line in paint too, so they keep most of their recipes.
        if (name === "White to black") {
          assert.equal(endpointRecipes, 4, `${name} at ${residualThreshold}`);
        }
        if (tintRows.has(name) && residualThreshold === 0.04) {
          assert.ok(recipes >= 3, `${name} keeps ${recipes} recipes at ${residualThreshold}`);
        }
      }
    }
  }
});

test("classifyPaletteColors emits only paint-consistent recipes in the crowded all-gradients palette", () => {
  // Every CSV gradient in one palette (see packages/core/scripts/
  // measure-gradient-fixtures.ts), so every other gradient's colors compete
  // as partners. Under the old "either path" rule #999999 came out as
  // yellow #F5F186 + blue #1C25A8 via the sRGB line — a grey no paint makes.
  const colors = gradientPalette(loadGradientFixtures());
  for (const residualThreshold of OKLAB_PRESETS) {
    const classifications = classifyPaletteColors(colors, {
      residualThreshold,
      mixCoveragePercent: 0
    });
    assertCoherent(classifications);
    for (const entry of classifications) {
      if (entry.classification !== "mix") continue;
      const label = `${entry.id} at ${residualThreshold}`;
      const partners = entry.recipe!.components.map((component) => component.colorId);
      const miss = recipeMiss(entry.recipe!, colors);
      assert.ok(miss <= residualThreshold + RECIPE_EPSILON, `${label} recipe misses by ${miss}`);
      // Two near-neutrals mix to a near-neutral in paint; a recipe may be
      // off by at most the threshold, so a target more chromatic than that
      // is not theirs to make.
      if (partners.every((partner) => oklabChroma(partner) < 0.02)) {
        assert.ok(
          oklabChroma(entry.id) <= residualThreshold,
          `${label} (chroma ${oklabChroma(entry.id)}) mixed from neutrals ${partners.join(" + ")}`
        );
      }
      if (entry.id === "#999999") {
        assert.notDeepEqual(partners.sort(), ["#1C25A8", "#F5F186"], `${label} is yellow + blue`);
      }
    }
  }
});
