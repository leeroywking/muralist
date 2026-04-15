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
    residualThreshold: 18,
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

  const classifications = classifyPaletteColors(colors, {
    residualThreshold: 18,
    mixCoveragePercent: 5
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
    { residualThreshold: 18, mixCoveragePercent: 5 }
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
    { residualThreshold: 18, mixCoveragePercent: 5 }
  );

  const accent = classifications.find((entry) => entry.id === "accent");
  assert.equal(accent?.classification, "buy");
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
    residualThreshold: 30,
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
    { residualThreshold: 18, mixCoveragePercent: 5 }
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
