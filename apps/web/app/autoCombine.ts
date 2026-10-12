// Auto-combine helpers for the editor (`PrototypeApp.tsx`), kept free of
// React so they can be unit-tested with node:test.
//
// Auto-combine is re-run from a snapshot of the palette as it was before the
// first Auto-combine (including the user's manual merges and lock flags), not
// from the palette a previous Auto-combine already shrank and re-weighted.
// That makes repeated presses and preset changes idempotent and
// order-independent: Aggressive -> Conservative gives the same result as
// Conservative straight from the snapshot. See docs/plans/mix-accuracy.md,
// "Auto-combine snapshot".

import {
  applyClassification,
  classifyPaletteColors,
  type MixRecipe,
  type PaletteClassification
} from "@muralist/core";

export type AutoCombineColor = {
  id: string;
  rgb: [number, number, number];
  pixelCount: number;
  coveragePercent: number;
  locked?: boolean;
};

/**
 * The palette Auto-combine classifies: the pre-combine snapshot when there is
 * one, otherwise the current palette. Lock flags come from the current
 * palette for every color still shown (the user may have locked or unlocked
 * a chip since the snapshot); colors an earlier Auto-combine folded away
 * keep the flag they had in the snapshot.
 */
export function autoCombineBase<T extends AutoCombineColor>(
  snapshot: readonly T[] | null,
  current: readonly T[]
): T[] {
  if (!snapshot) return current.map((color) => ({ ...color }));
  const currentById = new Map(current.map((color) => [color.id, color]));
  return snapshot.map((color) => {
    const shown = currentById.get(color.id);
    if (!shown) return { ...color };
    const next = { ...color };
    if (shown.locked) next.locked = true;
    else delete next.locked;
    return next;
  });
}

export type AutoCombineResult<T> = {
  palette: T[];
  classifications: Record<string, PaletteClassification>;
  mixes: MixRecipe[];
  absorbedCount: number;
};

/** Classify `base` and fold absorbed colors into their keepers. Pure. */
export function runAutoCombine<T extends AutoCombineColor>(
  base: readonly T[],
  options: { residualThreshold: number; mixCoveragePercent: number }
): AutoCombineResult<T> {
  const classifierInput = base.map((color) => ({
    id: color.id,
    rgb: color.rgb,
    pixelCount: color.pixelCount
  }));
  const lockedIds = new Set(base.filter((color) => color.locked).map((color) => color.id));
  const classifiedList = classifyPaletteColors(classifierInput, {
    residualThreshold: options.residualThreshold,
    mixCoveragePercent: options.mixCoveragePercent,
    lockedIds
  });
  const { nextColors, mixes, absorbedCount } = applyClassification(classifierInput, classifiedList);

  const pixelCountById = new Map(nextColors.map((entry) => [entry.id, entry.pixelCount]));
  const kept = base
    .filter((color) => pixelCountById.has(color.id))
    .map((color) => ({ ...color, pixelCount: pixelCountById.get(color.id)! }))
    .sort((left, right) => right.pixelCount - left.pixelCount);
  const totalPixels = kept.reduce((sum, color) => sum + color.pixelCount, 0);
  const palette = kept.map((color) => ({
    ...color,
    coveragePercent: totalPixels > 0 ? (color.pixelCount / totalPixels) * 100 : 0
  }));

  const retainedIds = new Set(palette.map((color) => color.id));
  const classifications: Record<string, PaletteClassification> = {};
  for (const entry of classifiedList) {
    if (retainedIds.has(entry.id)) classifications[entry.id] = entry.classification;
  }
  return { palette, classifications, mixes, absorbedCount };
}
