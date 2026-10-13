import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
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
    mixCoveragePercent: 5
  });

  const buyIds = classifications.filter((entry) => entry.classification === "buy").map((entry) => entry.id);
  const mixIds = classifications.filter((entry) => entry.classification === "mix").map((entry) => entry.id);

  // Endpoints survive as buy, every middle step (10% each, above the 5% mix
  // cutoff) becomes a red + blue recipe.
  assert.equal(buyIds.length, 2);
  assert.ok(buyIds.includes("step-0"));
  assert.ok(buyIds.includes(`step-${steps - 1}`));
  assert.equal(mixIds.length, steps - 2);

  // With mixCoveragePercent 50 every middle step is below the mix cutoff.
  // Before the absorb distance limit all of them folded into the nearer
  // endpoint (a mid purple painted red); now a step absorbs only into a buy
  // color within 2x the threshold of it, and steps that look like neither
  // end are kept as buy colors.
  const absorbRun = classifyPaletteColors(colors, {
    residualThreshold: 0.04,
    mixCoveragePercent: 50
  });
  const labById = new Map(colors.map((color) => [color.id, rgbToOklab(color.rgb)]));
  const absorbBuyIds = new Set(
    absorbRun.filter((entry) => entry.classification === "buy").map((entry) => entry.id)
  );
  assert.ok(absorbBuyIds.has("step-0") && absorbBuyIds.has(`step-${steps - 1}`));
  assert.ok(absorbBuyIds.size > 2 && absorbBuyIds.size < steps);
  for (const entry of absorbRun) {
    if (entry.classification !== "absorb") continue;
    const [L1, a1, b1] = labById.get(entry.id)!;
    const [L2, a2, b2] = labById.get(entry.absorbedIntoId!)!;
    assert.ok(Math.hypot(L1 - L2, a1 - a2, b1 - b2) <= 0.08 + 1e-9, `${entry.id} absorbed too far`);
  }
  assertCoherent(absorbRun);
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
  const purple = classByMap.get("purple");
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
  assert.equal(relaxedById.get("mid")?.classification, "mix");
  assert.equal(relaxedById.get("pinkish")?.classification, "absorb");
});

test("classifyPaletteColors still detects synthetic sRGB gradients at every preset", () => {
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
        assert.equal(entry.classification, "mix", `${hex} at ${residualThreshold}`);
        const fractions = Object.fromEntries(
          entry.recipe!.components.map((component) => [component.colorId, component.fraction])
        );
        const expectedLast = (index + 1) * 0.2;
        assert.ok(Math.abs((fractions[last] ?? 0) - expectedLast) < 0.03, `${hex} fraction`);
        assert.ok(Math.abs((fractions[first] ?? 0) - (1 - expectedLast)) < 0.03, `${hex} fraction`);
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
    assert.equal(lightTeal.classification, "mix", `at ${residualThreshold}`);
    const partners = lightTeal.recipe!.components.map((component) => component.colorId);
    assert.ok(partners.includes("#FFFFFF"));
    assert.ok(
      partners.includes("#3BB5B2") || partners.includes("#038D8C"),
      `light teal mixes from ${partners.join(" + ")} at ${residualThreshold}`
    );
    assert.ok(!partners.includes("#020F1A"));
  }

  // At the conservative preset both teals stay buy, and the light teal is
  // the white + #3BB5B2 tint the old classifier could not see.
  const conservative = classifyPaletteColors(colors, {
    residualThreshold: 0.02,
    mixCoveragePercent: 0
  });
  const byId = new Map(conservative.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("#3BB5B2")?.classification, "buy");
  assert.equal(byId.get("#038D8C")?.classification, "buy");
  assert.deepEqual(
    byId.get("#92D8D7")!.recipe!.components.map((component) => component.colorId).sort(),
    ["#3BB5B2", "#FFFFFF"]
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

test("classifyPaletteColors recovers every CSV fixture gradient step from its endpoints", () => {
  const gradients = loadGradientFixtures();
  assert.equal(gradients.length, 21);
  for (const { name, hexes } of gradients) {
    const colors = gradientPalette([{ name, hexes }]);
    const endpointA = hexes[0]!;
    const endpointB = hexes[hexes.length - 1]!;
    const interior = hexes.slice(1, -1);
    const totalPixels = colors.reduce((sum, color) => sum + color.pixelCount, 0);
    for (const residualThreshold of OKLAB_PRESETS) {
      for (const dominantCoveragePercent of [15, 100]) {
        const classifications = classifyPaletteColors(colors, {
          residualThreshold,
          mixCoveragePercent: 5,
          dominantCoveragePercent
        });
        const byId = new Map(classifications.map((entry) => [entry.id, entry]));
        interior.forEach((hex, index) => {
          const entry = byId.get(hex)!;
          const label = `${name} ${hex} at ${residualThreshold}, dominant ${dominantCoveragePercent}%`;
          if (entry.classification === "absorb" && residualThreshold > OKLAB_PRESETS[0]!) {
            assert.ok(hexes.includes(entry.absorbedIntoId!), `${label} absorbs outside its gradient`);
            return;
          }
          // Known exception, not a mix-fit failure: at the aggressive preset
          // the steps can sit closer than the near-duplicate distance, so one
          // step absorbs both neighbours and the merged clump crosses the
          // dominant cutoff, which pins it to buy (Orange to yellow at 0.07).
          // Only allowed when its own + absorbed pixels really are dominant.
          if (entry.classification === "buy" && residualThreshold > OKLAB_PRESETS[0]!) {
            const mergedPixels = colors
              .filter((color) => color.id === hex || byId.get(color.id)?.absorbedIntoId === hex)
              .reduce((sum, color) => sum + color.pixelCount, 0);
            assert.ok(
              (mergedPixels / totalPixels) * 100 >= dominantCoveragePercent,
              `${label} is buy without being dominant`
            );
            return;
          }
          assert.equal(entry.classification, "mix", label);
          const fractions = new Map(
            entry.recipe!.components.map((component) => [component.colorId, component.fraction])
          );
          assert.deepEqual([...fractions.keys()].sort(), [endpointA, endpointB].sort(), `${label} partners`);
          const expectedA = 0.8 - index * 0.2;
          assert.ok(
            Math.abs(fractions.get(endpointA)! - expectedA) <= 0.02,
            `${label}: endpoint A fraction ${fractions.get(endpointA)} vs ${expectedA}`
          );
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Color lock (lockedIds): a locked color is always buy; unlocked colors may
// still absorb into it or mix with it as a partner.
// ---------------------------------------------------------------------------

const LOCK_CLUSTERS: ClassifyPaletteInput[] = [
  { id: "red-main", rgb: [210, 40, 40], pixelCount: 100 },
  { id: "red-near", rgb: [214, 44, 43], pixelCount: 20 },
  { id: "blue-main", rgb: [40, 40, 210], pixelCount: 90 },
  { id: "blue-near", rgb: [36, 43, 213], pixelCount: 15 },
  { id: "mid", rgb: [125, 40, 125], pixelCount: 8 }
];

test("classifyPaletteColors keeps a small locked color as buy at every preset", () => {
  // Unlocked, "red-near" is a near-duplicate that folds into "red-main" and
  // "mid" (3.4%) sits on the red-blue line (a mix at a 0% mix cutoff).
  // Locked, both stay buy.
  for (const residualThreshold of OKLAB_PRESETS) {
    const baseline = new Map(
      classifyPaletteColors(LOCK_CLUSTERS, { residualThreshold, mixCoveragePercent: 5 }).map(
        (entry) => [entry.id, entry]
      )
    );
    assert.equal(baseline.get("red-near")?.classification, "absorb", `baseline at ${residualThreshold}`);
    // "mid" is a purple far from both red and blue, so below the mix cutoff
    // it is no longer absorbed (absorb distance limit); with a 0% mix cutoff
    // it is a red + blue mix unless locked.
    const mixBaseline = classifyPaletteColors(LOCK_CLUSTERS, { residualThreshold, mixCoveragePercent: 0 });
    assert.equal(
      mixBaseline.find((entry) => entry.id === "mid")?.classification,
      "mix",
      `baseline at ${residualThreshold}`
    );

    for (const mixCoveragePercent of [0, 5]) {
      const classifications = classifyPaletteColors(LOCK_CLUSTERS, {
        residualThreshold,
        mixCoveragePercent,
        lockedIds: new Set(["red-near", "mid"])
      });
      const byId = new Map(classifications.map((entry) => [entry.id, entry]));
      const label = `threshold ${residualThreshold}, mix ${mixCoveragePercent}%`;
      assert.equal(byId.get("red-near")?.classification, "buy", label);
      assert.equal(byId.get("mid")?.classification, "buy", label);
      assertCoherent(classifications);
    }
  }
});

test("classifyPaletteColors never makes a locked color a mix target", () => {
  // With the dominant rule relaxed "mid" is a perfect red-blue mix; locking
  // it keeps it buy and no recipe targets it.
  const colors: ClassifyPaletteInput[] = [
    { id: "red", rgb: [220, 20, 20], pixelCount: 300 },
    { id: "blue", rgb: [20, 20, 220], pixelCount: 300 },
    { id: "mid", rgb: [120, 20, 120], pixelCount: 200 }
  ];
  const options = { residualThreshold: 0.04, mixCoveragePercent: 5, dominantCoveragePercent: 50 };
  const unlocked = classifyPaletteColors(colors, options);
  assert.equal(unlocked.find((entry) => entry.id === "mid")?.classification, "mix");

  const locked = classifyPaletteColors(colors, { ...options, lockedIds: new Set(["mid"]) });
  const mid = locked.find((entry) => entry.id === "mid")!;
  assert.equal(mid.classification, "buy");
  assert.equal(mid.recipe, undefined);
  assert.ok(locked.every((entry) => entry.recipe?.targetColorId !== "mid"));
  assertCoherent(locked);
});

test("classifyPaletteColors keeps the locked member of a near-duplicate pair even when it is smaller", () => {
  // "red-near" (20 px) is a near-duplicate of "red-main" (100 px). Locked, it
  // is the keeper: a non-dominant "red-main" absorbs into it; a dominant
  // "red-main" is never absorbed, so both stay buy.
  const lockedIds = new Set(["red-near"]);
  for (const residualThreshold of OKLAB_PRESETS) {
    const relaxed = classifyPaletteColors(LOCK_CLUSTERS, {
      residualThreshold,
      mixCoveragePercent: 5,
      dominantCoveragePercent: 100,
      lockedIds
    });
    const relaxedById = new Map(relaxed.map((entry) => [entry.id, entry]));
    assert.equal(relaxedById.get("red-near")?.classification, "buy", `${residualThreshold}`);
    assert.equal(relaxedById.get("red-main")?.classification, "absorb", `${residualThreshold}`);
    assert.equal(relaxedById.get("red-main")?.absorbedIntoId, "red-near", `${residualThreshold}`);
    assertCoherent(relaxed);
    const applied = applyClassification(LOCK_CLUSTERS, relaxed);
    assert.equal(applied.nextColors.find((entry) => entry.id === "red-near")?.pixelCount, 120);

    // Default dominant cutoff: red-main covers 43%, so it stays too.
    const strict = classifyPaletteColors(LOCK_CLUSTERS, {
      residualThreshold,
      mixCoveragePercent: 5,
      lockedIds
    });
    const strictById = new Map(strict.map((entry) => [entry.id, entry]));
    assert.equal(strictById.get("red-near")?.classification, "buy", `${residualThreshold}`);
    assert.equal(strictById.get("red-main")?.classification, "buy", `${residualThreshold}`);
    assertCoherent(strict);
  }

  // Two locked near-duplicates never merge with each other.
  const both = classifyPaletteColors(LOCK_CLUSTERS, {
    residualThreshold: 0.07,
    mixCoveragePercent: 5,
    dominantCoveragePercent: 100,
    lockedIds: new Set(["red-near", "red-main"])
  });
  const bothById = new Map(both.map((entry) => [entry.id, entry]));
  assert.equal(bothById.get("red-near")?.classification, "buy");
  assert.equal(bothById.get("red-main")?.classification, "buy");
  assertCoherent(both);
});

test("classifyPaletteColors lets unlocked colors mix with a locked partner", () => {
  // "blue-lock" is a near-duplicate of the larger "blue". Unlocked it folds
  // into "blue" and "mid" mixes red + blue; locked, "blue" folds into it and
  // "mid" (the sRGB midpoint of red and blue-lock) mixes red + blue-lock.
  const colors: ClassifyPaletteInput[] = [
    { id: "red", rgb: [220, 20, 20], pixelCount: 300 },
    { id: "blue", rgb: [20, 20, 220], pixelCount: 40 },
    { id: "blue-lock", rgb: [24, 22, 214], pixelCount: 25 },
    { id: "mid", rgb: [122, 21, 117], pixelCount: 15 }
  ];
  const options = { residualThreshold: 0.04, mixCoveragePercent: 0 };
  const partnersOf = (classifications: ReturnType<typeof classifyPaletteColors>) =>
    classifications
      .find((entry) => entry.id === "mid")!
      .recipe!.components.map((component) => component.colorId)
      .sort();

  const unlocked = classifyPaletteColors(colors, options);
  assert.deepEqual(partnersOf(unlocked), ["blue", "red"]);

  const locked = classifyPaletteColors(colors, { ...options, lockedIds: new Set(["blue-lock"]) });
  const byId = new Map(locked.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("blue-lock")?.classification, "buy");
  assert.equal(byId.get("blue")?.absorbedIntoId, "blue-lock");
  assert.equal(byId.get("mid")?.classification, "mix");
  assert.deepEqual(partnersOf(locked), ["blue-lock", "red"]);
  assertCoherent(locked);
});

test("classifyPaletteColors keeps absorb/mix targets on buy colors with locks across presets and palettes", () => {
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
    clusters: LOCK_CLUSTERS,
    gradients: gradientPalette(loadGradientFixtures().slice(0, 4))
  };
  for (const [name, colors] of Object.entries(palettes)) {
    const bySize = [...colors].sort((left, right) => left.pixelCount - right.pixelCount);
    const lockSets = [
      new Set(bySize.slice(0, 2).map((color) => color.id)),
      new Set(bySize.filter((_, index) => index % 2 === 1).map((color) => color.id)),
      new Set(colors.map((color) => color.id))
    ];
    for (const lockedIds of lockSets) {
      for (const residualThreshold of OKLAB_PRESETS) {
        for (const dominantCoveragePercent of [15, 100]) {
          const classifications = classifyPaletteColors(colors, {
            residualThreshold,
            mixCoveragePercent: 5,
            dominantCoveragePercent,
            lockedIds
          });
          const label = `${name} at ${residualThreshold}, dominant ${dominantCoveragePercent}%`;
          for (const entry of classifications) {
            if (lockedIds.has(entry.id)) assert.equal(entry.classification, "buy", `${entry.id} in ${label}`);
          }
          assertCoherent(classifications);
          assert.doesNotThrow(() => applyClassification(colors, classifications));
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Paint plausibility: a mix recipe must be something a painter could make.
// Mixing never raises chroma, never leaves the partners' value range, and
// keeps hue on the arc between the partners (tints/shades keep their hue;
// complements dull toward grey).
// ---------------------------------------------------------------------------

function oklch(hex: string): { L: number; C: number; h: number } {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

// Real FlowerRepeat analyzer palette (docs/example_art/FlowerRepeat.jpg, live
// Variant A preview), top colors with their reported coverage.
const FLOWER_REPEAT = paletteFromHexCoverage([
  ["#313D52", 26.5], // navy
  ["#8AC6BE", 10.9], // mint
  ["#E2BEC1", 9.4],
  ["#E699A3", 7.6], // pink
  ["#45B0B3", 7.3],
  ["#FAFBFB", 4.8], // white
  ["#F9D55F", 4.6], // light yellow
  ["#F5C233", 4.3], // dark yellow
  ["#84B73F", 4.2] // green
]);

test("classifyPaletteColors never makes FlowerRepeat's dark yellow from light yellow + navy", () => {
  // Balanced, mix threshold 0 used to return #F5C233 = 7% #313D52 + 93%
  // #F9D55F: a more saturated yellow from a duller yellow and a navy.
  for (const residualThreshold of OKLAB_PRESETS) {
    for (const mixCoveragePercent of [0, 5]) {
      const classifications = classifyPaletteColors(FLOWER_REPEAT, {
        residualThreshold,
        mixCoveragePercent
      });
      const label = `threshold ${residualThreshold}, mix ${mixCoveragePercent}%`;
      const darkYellow = classifications.find((entry) => entry.id === "#F5C233")!;
      if (darkYellow.classification === "mix") {
        const partners = darkYellow.recipe!.components.map((component) => component.colorId);
        assert.ok(!partners.includes("#313D52"), `dark yellow mixes with navy at ${label}`);
      }
      assertCoherent(classifications);
      assertPlausibleRecipes(FLOWER_REPEAT, classifications, label);
    }
  }

  // With white present, light yellow is the tint (white + dark yellow), or
  // stays buy; dark yellow is the paint to buy.
  const balanced = classifyPaletteColors(FLOWER_REPEAT, {
    residualThreshold: 0.04,
    mixCoveragePercent: 0
  });
  const byId = new Map(balanced.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("#F5C233")?.classification, "buy");
  const lightYellow = byId.get("#F9D55F")!;
  if (lightYellow.classification === "mix") {
    assert.deepEqual(
      lightYellow.recipe!.components.map((component) => component.colorId).sort(),
      ["#F5C233", "#FAFBFB"]
    );
  } else {
    assert.equal(lightYellow.classification, "buy");
  }
});

// Every mix recipe passes the same plausibility rules, measured independently
// of the classifier: chroma ceiling, value bracket, and no chromatic target
// from two neutral partners.
function assertPlausibleRecipes(
  colors: ClassifyPaletteInput[],
  classifications: ReturnType<typeof classifyPaletteColors>,
  label: string
) {
  const hexById = new Map(
    colors.map((color) => [
      color.id,
      `#${color.rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
    ])
  );
  for (const entry of classifications) {
    if (entry.classification !== "mix") continue;
    const target = oklch(hexById.get(entry.id)!);
    const [first, second] = entry.recipe!.components.map((component) =>
      oklch(hexById.get(component.colorId)!)
    );
    const context = `${entry.id} = ${entry.recipe!.components
      .map((component) => `${component.fraction} ${component.colorId}`)
      .join(" + ")} at ${label}`;
    assert.ok(target.C <= Math.max(first!.C, second!.C) + 0.015, `chroma rises: ${context}`);
    assert.ok(target.L <= Math.max(first!.L, second!.L) + 0.07, `brighter than both: ${context}`);
    assert.ok(target.L >= Math.min(first!.L, second!.L) - 0.07, `darker than both: ${context}`);
    if (target.C > 0.04) {
      assert.ok(first!.C > 0.025 || second!.C > 0.025, `chromatic from two neutrals: ${context}`);
    }
  }
}

test("classifyPaletteColors recipes stay paint-plausible on the fixture palettes", () => {
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
    flowerRepeat: FLOWER_REPEAT,
    gradients: gradientPalette(loadGradientFixtures())
  };
  for (const [name, colors] of Object.entries(palettes)) {
    for (const residualThreshold of OKLAB_PRESETS) {
      for (const dominantCoveragePercent of [15, 100]) {
        const label = `${name} at ${residualThreshold}, dominant ${dominantCoveragePercent}%`;
        const classifications = classifyPaletteColors(colors, {
          residualThreshold,
          mixCoveragePercent: 0,
          dominantCoveragePercent
        });
        assertCoherent(classifications);
        assertPlausibleRecipes(colors, classifications, label);
      }
    }
  }
});

test("classifyPaletteColors rejects a near-white tint of a hue the partner does not have", () => {
  // Pale pink #FCDCEA (C 0.040, h 350) sits 0.060 from the sRGB line
  // white -> teal, inside the aggressive threshold, only because pale colors
  // are all close together; a tint keeps its partner's hue (teal is h ~205),
  // so it must not be made from white + teal.
  const colors: ClassifyPaletteInput[] = [
    { id: "white", rgb: [252, 252, 252], pixelCount: 500 },
    { id: "teal", rgb: [24, 141, 155], pixelCount: 300 },
    { id: "blush", rgb: [252, 220, 234], pixelCount: 60 }
  ];
  const classifications = classifyPaletteColors(colors, {
    residualThreshold: 0.07,
    mixCoveragePercent: 0
  });
  assert.equal(classifications.find((entry) => entry.id === "blush")?.classification, "buy");
});

// ---------------------------------------------------------------------------
// Distinct small colors: a small color is only absorbed into a buy color it
// actually resembles; sub-floor anti-aliasing edges still absorb.
// ---------------------------------------------------------------------------

// Octopus analyzer palette (feedback/IMG_3043.jpg), top colors.
const OCTOPUS = paletteFromHexCoverage([
  ["#DA7183", 28.1], // body pink
  ["#76C6E9", 21.8], // sky blue
  ["#C9A892", 8.8], // tan
  ["#FCFCFC", 6.2], // white
  ["#0A1E64", 5.4], // navy
  ["#FDB2C0", 3.6], // light-pink suckers
  ["#188D9B", 2.9],
  ["#83263E", 2.9]
]);

test("classifyPaletteColors keeps the octopus's light-pink suckers at Balanced", () => {
  const classifications = classifyPaletteColors(OCTOPUS, {
    residualThreshold: 0.04,
    mixCoveragePercent: 5
  });
  const suckers = classifications.find((entry) => entry.id === "#FDB2C0")!;
  assert.equal(suckers.classification, "buy", `suckers absorbed into ${suckers.absorbedIntoId}`);
  assertCoherent(classifications);
});

test("classifyPaletteColors never absorbs a small color into a buy color it does not resemble", () => {
  for (const residualThreshold of OKLAB_PRESETS) {
    for (const [name, colors] of Object.entries({ OCTOPUS, FLOWER_REPEAT })) {
      const classifications = classifyPaletteColors(colors, {
        residualThreshold,
        mixCoveragePercent: 5
      });
      const totalPixels = colors.reduce((sum, color) => sum + color.pixelCount, 0);
      const byId = new Map(colors.map((color) => [color.id, color]));
      for (const entry of classifications) {
        if (entry.classification !== "absorb") continue;
        const color = byId.get(entry.id)!;
        // Below 1% coverage, line-fitting colors are edge clutter and absorb.
        if ((color.pixelCount / totalPixels) * 100 < 1) continue;
        const [L1, a1, b1] = rgbToOklab(color.rgb);
        const [L2, a2, b2] = rgbToOklab(byId.get(entry.absorbedIntoId!)!.rgb);
        const distance = Math.hypot(L1 - L2, a1 - a2, b1 - b2);
        assert.ok(
          distance <= residualThreshold * 2 + 1e-9,
          `${name}: ${entry.id} absorbed into ${entry.absorbedIntoId} ${distance.toFixed(3)} away at ${residualThreshold}`
        );
      }
    }
  }
});

test("classifyPaletteColors still absorbs tiny anti-aliasing colors between two flats", () => {
  // Two flat areas and the edge pixels between them: sRGB 25/50/75% blends
  // at 0.2% coverage each. They fit the line and are far from both flats,
  // but they are edge clutter, so they absorb at every preset.
  const flatA: [number, number, number] = [218, 113, 131];
  const flatB: [number, number, number] = [118, 198, 233];
  const colors: ClassifyPaletteInput[] = [
    { id: "flat-a", rgb: flatA, pixelCount: 5000 },
    { id: "flat-b", rgb: flatB, pixelCount: 4940 }
  ];
  for (const t of [0.25, 0.5, 0.75]) {
    colors.push({
      id: `edge-${t}`,
      rgb: flatA.map((channel, index) => Math.round(channel + (flatB[index]! - channel) * t)) as [
        number,
        number,
        number
      ],
      pixelCount: 20
    });
  }
  for (const residualThreshold of OKLAB_PRESETS) {
    const classifications = classifyPaletteColors(colors, {
      residualThreshold,
      mixCoveragePercent: 5
    });
    for (const entry of classifications.filter((item) => item.id.startsWith("edge-"))) {
      assert.equal(entry.classification, "absorb", `${entry.id} at ${residualThreshold}`);
    }
  }
});

test("classifyPaletteColors keeps Coral's flat red at Aggressive", () => {
  // Coral analyzer palette (docs/example_art/Coral.jpg). The flat red
  // #D93A48 is 0.065 from the magenta #DA246D — visibly a different red —
  // and the aggressive preset used to merge it away as a near-duplicate.
  const coral = paletteFromHexCoverage([
    ["#913178", 21.9],
    ["#7ABD53", 17.9],
    ["#DA246D", 14.8],
    ["#EDA93C", 12.8],
    ["#FEFFFE", 11],
    ["#77B4CD", 9.6],
    ["#D93A48", 6.3]
  ]);
  for (const residualThreshold of OKLAB_PRESETS) {
    const classifications = classifyPaletteColors(coral, {
      residualThreshold,
      mixCoveragePercent: 5
    });
    const red = classifications.find((entry) => entry.id === "#D93A48")!;
    assert.notEqual(red.classification, "absorb", `red absorbed into ${red.absorbedIntoId} at ${residualThreshold}`);
  }
});

// ---------------------------------------------------------------------------
// Background colors (bare wall, no paint): never a mix partner, never a mix
// target, never absorbed. Near-duplicates and sub-1% edge pixels may still
// fold into them. See docs/plans/mix-accuracy.md, "Background colors and
// mixing".
// ---------------------------------------------------------------------------

const BACKGROUND_PALETTES: Record<string, { colors: ClassifyPaletteInput[]; backgroundId: string }> = {
  teal: {
    colors: paletteFromHexCoverage([
      ["#FFFFFF", 50.7],
      ["#92D8D7", 21.4],
      ["#038D8C", 8.9],
      ["#390E5D", 6.9],
      ["#FAD678", 6.0],
      ["#020F1A", 3.3],
      ["#3BB5B2", 2.7],
      ["#C1A76C", 0.1]
    ]),
    backgroundId: "#FFFFFF"
  },
  flowerRepeat: { colors: FLOWER_REPEAT, backgroundId: "#FAFBFB" },
  grays: {
    colors: paletteFromHexCoverage([
      ["#FFFFFF", 35],
      ["#000000", 25],
      ["#808080", 20],
      ["#404040", 6],
      ["#858585", 5],
      ["#C0C0C0", 5],
      ["#7B7B7B", 4]
    ]),
    backgroundId: "#FFFFFF"
  }
};

test("classifyPaletteColors never uses a background color as a mix partner, target or absorbed color", () => {
  for (const [name, { colors, backgroundId }] of Object.entries(BACKGROUND_PALETTES)) {
    for (const residualThreshold of OKLAB_PRESETS) {
      for (const mixCoveragePercent of [0, 5]) {
        for (const dominantCoveragePercent of [15, 100]) {
          // Locked + background on the same color: background wins for the
          // partner rule.
          for (const lockBackground of [false, true]) {
            const label = `${name}, threshold ${residualThreshold}, mix ${mixCoveragePercent}%, dominant ${dominantCoveragePercent}%, locked ${lockBackground}`;
            const classifications = classifyPaletteColors(colors, {
              residualThreshold,
              mixCoveragePercent,
              dominantCoveragePercent,
              backgroundIds: new Set([backgroundId]),
              lockedIds: lockBackground ? new Set([backgroundId]) : undefined
            });
            const background = classifications.find((entry) => entry.id === backgroundId)!;
            assert.equal(background.classification, "buy", `background reclassified at ${label}`);
            for (const entry of classifications) {
              if (entry.classification !== "mix") continue;
              const partners = entry.recipe!.components.map((component) => component.colorId);
              assert.ok(!partners.includes(backgroundId), `${entry.id} mixes with the background at ${label}`);
            }
            assertCoherent(classifications);
            assertPlausibleRecipes(colors, classifications, label);
            assert.doesNotThrow(() => applyClassification(colors, classifications));
          }
        }
      }
    }
  }
});

test("classifyPaletteColors does not make FlowerRepeat's light yellow from a background white", () => {
  // Balanced, mix threshold 0: without background ids light yellow is
  // white + dark yellow. With white as bare wall it must buy or use another
  // plausible recipe.
  const classifications = classifyPaletteColors(FLOWER_REPEAT, {
    residualThreshold: 0.04,
    mixCoveragePercent: 0,
    backgroundIds: new Set(["#FAFBFB"])
  });
  const lightYellow = classifications.find((entry) => entry.id === "#F9D55F")!;
  assert.notEqual(lightYellow.classification, "absorb");
  if (lightYellow.classification === "mix") {
    assert.ok(
      !lightYellow.recipe!.components.some((component) => component.colorId === "#FAFBFB"),
      "light yellow mixes with the background"
    );
  }
});

test("classifyPaletteColors folds near-duplicates of a background color into it", () => {
  // Paper grain / wall texture: a slightly darker white that is even larger
  // than the background chip still folds into the background (like a lock).
  const colors = paletteFromHexCoverage([...FLOWER_REPEAT.map((color) => [
    `#${color.rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`,
    color.pixelCount / 10
  ] as [string, number]), ["#F6F7F7", 6.0]]);
  for (const residualThreshold of OKLAB_PRESETS) {
    const classifications = classifyPaletteColors(colors, {
      residualThreshold,
      mixCoveragePercent: 5,
      backgroundIds: new Set(["#FAFBFB"])
    });
    const byId = new Map(classifications.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("#FAFBFB")?.classification, "buy", `at ${residualThreshold}`);
    assert.equal(byId.get("#F6F7F7")?.classification, "absorb", `at ${residualThreshold}`);
    assert.equal(byId.get("#F6F7F7")?.absorbedIntoId, "#FAFBFB", `at ${residualThreshold}`);
    assertCoherent(classifications);
  }
});

test("classifyPaletteColors absorbs sub-1% edge pixels into a nearer background color but never mixes them", () => {
  // Anti-aliasing between a bare white wall and a flat red: the 0.4% edge
  // pixel sits 20% of the way from white to red.
  const white: [number, number, number] = [255, 255, 255];
  const red: [number, number, number] = [200, 30, 40];
  const edge = white.map((channel, index) => Math.round(channel * 0.8 + red[index]! * 0.2)) as [
    number,
    number,
    number
  ];
  const colors: ClassifyPaletteInput[] = [
    { id: "wall", rgb: white, pixelCount: 5000 },
    { id: "red", rgb: red, pixelCount: 3000 },
    { id: "blue", rgb: [30, 40, 200], pixelCount: 1960 },
    { id: "edge", rgb: edge, pixelCount: 40 }
  ];
  for (const residualThreshold of OKLAB_PRESETS) {
    const absorbed = classifyPaletteColors(colors, {
      residualThreshold,
      mixCoveragePercent: 5,
      backgroundIds: new Set(["wall"])
    });
    const edgeEntry = absorbed.find((entry) => entry.id === "edge")!;
    assert.equal(edgeEntry.classification, "absorb", `at ${residualThreshold}`);
    assert.equal(edgeEntry.absorbedIntoId, "wall", `at ${residualThreshold}`);

    // Mix threshold 0 keeps every color exact; a wall + paint recipe is not
    // possible, so the edge pixel stays its own buy color.
    const exact = classifyPaletteColors(colors, {
      residualThreshold,
      mixCoveragePercent: 0,
      backgroundIds: new Set(["wall"])
    });
    assert.equal(exact.find((entry) => entry.id === "edge")?.classification, "buy", `at ${residualThreshold}`);
  }
});
