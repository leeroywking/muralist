// Tests for the Auto-combine snapshot helpers in `autoCombine.ts`. The
// editor re-classifies from the pre-combine snapshot every time, so repeated
// presses and preset changes are idempotent and order-independent.

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyValidMixesToCoverage,
  autoCombineBase,
  dropRecipesUsingColor,
  runAutoCombine,
  type AutoCombineColor
} from "./autoCombine.js";

const PRESETS = { conservative: 0.02, balanced: 0.04, aggressive: 0.07 };

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [
    number,
    number,
    number
  ];
}

// Octopus-like palette (feedback/IMG_3043.jpg analyzer colors).
function palette(): AutoCombineColor[] {
  const entries: [string, number][] = [
    ["#DA7183", 28.1],
    ["#76C6E9", 21.8],
    ["#C9A892", 8.8],
    ["#FCFCFC", 6.2],
    ["#0A1E64", 5.4],
    ["#FDB2C0", 3.6],
    ["#188D9B", 2.9],
    ["#83263E", 2.9],
    ["#2E3F9C", 2.3],
    ["#B65D6B", 1.9],
    ["#5E5E5C", 1.6],
    ["#0363A7", 1.4],
    ["#A6495E", 1.2],
    ["#913C53", 0.9],
    ["#D6889C", 0.6],
    ["#E9A1AE", 0.4],
    ["#9FC3D6", 0.3]
  ];
  return entries.map(([hex, coverage]) => ({
    id: hex,
    rgb: hexToRgb(hex),
    pixelCount: Math.round(coverage * 10),
    coveragePercent: coverage
  }));
}

function summary(result: ReturnType<typeof runAutoCombine>) {
  return {
    ids: result.palette.map((color) => `${color.id}:${color.pixelCount}`),
    classifications: result.classifications,
    mixes: result.mixes
  };
}

// Simulates the editor: a snapshot is taken on the first press and every
// press re-classifies from it.
function pressSequence(presets: number[], mixCoveragePercent: number) {
  let snapshot: AutoCombineColor[] | null = null;
  let current = palette();
  let last: ReturnType<typeof runAutoCombine> | null = null;
  for (const residualThreshold of presets) {
    const base: AutoCombineColor[] = autoCombineBase(snapshot, current);
    snapshot = snapshot ?? base;
    last = runAutoCombine(base, { residualThreshold, mixCoveragePercent });
    current = last.palette;
  }
  return last!;
}

test("re-running Auto-combine on its own output drifts (the bug the snapshot fixes)", () => {
  const first = runAutoCombine(palette(), { residualThreshold: PRESETS.aggressive, mixCoveragePercent: 5 });
  const chained = runAutoCombine(first.palette, {
    residualThreshold: PRESETS.conservative,
    mixCoveragePercent: 5
  });
  const fresh = runAutoCombine(palette(), {
    residualThreshold: PRESETS.conservative,
    mixCoveragePercent: 5
  });
  assert.notDeepEqual(summary(chained), summary(fresh));
});

test("Auto-combine from the snapshot is order-independent across presets", () => {
  for (const mixCoveragePercent of [0, 5]) {
    for (const target of Object.values(PRESETS)) {
      const fresh = runAutoCombine(palette(), { residualThreshold: target, mixCoveragePercent });
      for (const before of Object.values(PRESETS)) {
        const sequence = pressSequence([before, PRESETS.aggressive, before, target], mixCoveragePercent);
        assert.deepEqual(
          summary(sequence),
          summary(fresh),
          `${before} -> aggressive -> ${before} -> ${target} at mix ${mixCoveragePercent}%`
        );
      }
      // Pressing the same preset twice is a no-op.
      assert.deepEqual(summary(pressSequence([target, target], mixCoveragePercent)), summary(fresh));
    }
  }
});

test("autoCombineBase applies current lock flags onto the snapshot", () => {
  const snapshot = palette();
  snapshot[5] = { ...snapshot[5]!, locked: true }; // #FDB2C0 locked before combining
  const combined = runAutoCombine(snapshot, { residualThreshold: PRESETS.aggressive, mixCoveragePercent: 5 });
  // After combining the user unlocks #FDB2C0 and locks the navy.
  const current = combined.palette.map((color) => {
    if (color.id === "#FDB2C0") return { ...color, locked: undefined };
    if (color.id === "#0A1E64") return { ...color, locked: true };
    return color;
  });
  const base = autoCombineBase(snapshot, current);
  assert.equal(base.length, snapshot.length, "every snapshot color comes back");
  const byId = new Map(base.map((color) => [color.id, color]));
  assert.equal(byId.get("#FDB2C0")?.locked, undefined);
  assert.equal(byId.get("#0A1E64")?.locked, true);
  // Pixel counts are the snapshot's, not the re-weighted combined ones.
  for (const color of snapshot) assert.equal(byId.get(color.id)?.pixelCount, color.pixelCount);

  // A locked color always stays buy.
  const result = runAutoCombine(base, { residualThreshold: PRESETS.aggressive, mixCoveragePercent: 5 });
  assert.equal(result.classifications["#0A1E64"], "buy");
});

test("without a snapshot Auto-combine starts from the current palette", () => {
  const current = palette();
  assert.deepEqual(autoCombineBase(null, current), current);
});

// FlowerRepeat analyzer palette (docs/example_art/FlowerRepeat.jpg). At
// Balanced / mix 0 light yellow #F9D55F is white + dark yellow unless white
// is marked as background.
function flowerRepeat(): AutoCombineColor[] {
  const entries: [string, number][] = [
    ["#313D52", 26.5],
    ["#8AC6BE", 10.9],
    ["#E2BEC1", 9.4],
    ["#E699A3", 7.6],
    ["#45B0B3", 7.3],
    ["#FAFBFB", 4.8],
    ["#F9D55F", 4.6],
    ["#F5C233", 4.3],
    ["#84B73F", 4.2]
  ];
  return entries.map(([hex, coverage]) => ({
    id: hex,
    rgb: hexToRgb(hex),
    pixelCount: Math.round(coverage * 10),
    coveragePercent: coverage
  }));
}

test("Auto-combine never mixes with a background color", () => {
  const withoutBackground = runAutoCombine(flowerRepeat(), { residualThreshold: PRESETS.balanced, mixCoveragePercent: 0 });
  assert.ok(
    withoutBackground.mixes.some((mix) => mix.components.some((component) => component.colorId === "#FAFBFB")),
    "precondition: white is a partner when it is not background"
  );
  for (const residualThreshold of Object.values(PRESETS)) {
    for (const mixCoveragePercent of [0, 5]) {
      const result = runAutoCombine(flowerRepeat(), {
        residualThreshold,
        mixCoveragePercent,
        backgroundIds: new Set(["#FAFBFB"])
      });
      const label = `${residualThreshold} at mix ${mixCoveragePercent}%`;
      assert.equal(result.classifications["#FAFBFB"], "buy", label);
      for (const mix of result.mixes) {
        assert.ok(
          !mix.components.some((component) => component.colorId === "#FAFBFB"),
          `${mix.targetColorId} mixes with the background at ${label}`
        );
      }
    }
  }
});

test("dropRecipesUsingColor removes recipes that use a new background color and makes their targets buy", () => {
  const result = runAutoCombine(flowerRepeat(), { residualThreshold: PRESETS.balanced, mixCoveragePercent: 0 });
  const dropped = dropRecipesUsingColor(result.mixes, result.classifications, "#FAFBFB");
  assert.ok(dropped.droppedTargetIds.length > 0);
  for (const mix of dropped.mixes) {
    assert.ok(!mix.components.some((component) => component.colorId === "#FAFBFB"));
    assert.notEqual(mix.targetColorId, "#FAFBFB");
  }
  for (const id of dropped.droppedTargetIds) assert.equal(dropped.classifications[id], "buy");
  // Recipes that do not touch the color are kept.
  const untouched = result.mixes.filter(
    (mix) =>
      mix.targetColorId !== "#FAFBFB" &&
      !mix.components.some((component) => component.colorId === "#FAFBFB")
  );
  assert.deepEqual(dropped.mixes, untouched);
});

test("applyValidMixesToCoverage skips only recipes that reference missing colors", () => {
  const coverage = [
    { id: "a", coveragePercent: 40 },
    { id: "b", coveragePercent: 30 },
    { id: "ab", coveragePercent: 10 },
    { id: "lonely", coveragePercent: 5 }
  ];
  const good = {
    targetColorId: "ab",
    components: [
      { colorId: "a", fraction: 0.5 },
      { colorId: "b", fraction: 0.5 }
    ]
  };
  // "wall" is a background color, so it is not in the paintable coverage list.
  const usesBackground = {
    targetColorId: "lonely",
    components: [
      { colorId: "a", fraction: 0.5 },
      { colorId: "wall", fraction: 0.5 }
    ]
  };
  const result = applyValidMixesToCoverage(coverage, [good, usesBackground]);
  assert.deepEqual(result, [
    { id: "a", coveragePercent: 45 },
    { id: "b", coveragePercent: 35 },
    { id: "lonely", coveragePercent: 5 }
  ]);
  // A recipe whose target is no longer listed is skipped too.
  assert.deepEqual(
    applyValidMixesToCoverage(coverage, [{ ...good, targetColorId: "gone" }]),
    coverage
  );
});
