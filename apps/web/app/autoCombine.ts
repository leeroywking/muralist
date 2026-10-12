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
  applyMixesToCoverage,
  classifyPaletteColors,
  type ColorAreaInput,
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
  options: {
    residualThreshold: number;
    mixCoveragePercent: number;
    /** Background (bare wall) color ids: never a mix partner, never mixed or
     * absorbed (see ClassifyPaletteOptions.backgroundIds). */
    backgroundIds?: ReadonlySet<string>;
  }
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
    lockedIds,
    backgroundIds: options.backgroundIds
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

/**
 * Marking a color as background after an Auto-combine: recipes that use it
 * as a partner (or mix it) are dropped and their targets become buy colors.
 * The rest of the classification is left alone; pressing Auto-combine again
 * re-classifies from the snapshot with the color excluded as a partner.
 */
export function dropRecipesUsingColor(
  mixes: readonly MixRecipe[],
  classifications: Readonly<Record<string, PaletteClassification>>,
  colorId: string
): { mixes: MixRecipe[]; classifications: Record<string, PaletteClassification>; droppedTargetIds: string[] } {
  const kept: MixRecipe[] = [];
  const droppedTargetIds: string[] = [];
  for (const mix of mixes) {
    if (
      mix.targetColorId === colorId ||
      mix.components.some((component) => component.colorId === colorId)
    ) {
      droppedTargetIds.push(mix.targetColorId);
    } else {
      kept.push(mix);
    }
  }
  const nextClassifications = { ...classifications };
  for (const id of droppedTargetIds) {
    if (id in nextClassifications) nextClassifications[id] = "buy";
  }
  return { mixes: kept, classifications: nextClassifications, droppedTargetIds };
}

/**
 * applyMixesToCoverage over the recipes that still make sense for `colors`
 * (the paintable palette): a recipe whose target or any component is not in
 * the list — e.g. it uses a color since marked as background, or a color a
 * manual merge removed — is skipped, so one stale recipe never drops every
 * mix from the estimate.
 */
export function applyValidMixesToCoverage(
  colors: readonly ColorAreaInput[],
  mixes: readonly MixRecipe[]
): ColorAreaInput[] {
  const ids = new Set(colors.map((color) => color.id));
  const valid = mixes.filter(
    (mix) =>
      ids.has(mix.targetColorId) &&
      mix.components.every((component) => ids.has(component.colorId)) &&
      Math.abs(mix.components.reduce((sum, component) => sum + component.fraction, 0) - 1) <= 1e-3
  );
  return applyMixesToCoverage([...colors], valid);
}
