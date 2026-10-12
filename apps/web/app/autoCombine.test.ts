// Tests for the Auto-combine snapshot helpers in `autoCombine.ts`. The
// editor re-classifies from the pre-combine snapshot every time, so repeated
// presses and preset changes are idempotent and order-independent.

import test from "node:test";
import assert from "node:assert/strict";

import { autoCombineBase, runAutoCombine, type AutoCombineColor } from "./autoCombine.js";

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
