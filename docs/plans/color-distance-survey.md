# Palette survey by color difference, not popularity

## Problem

The initial palette survey dropped small-but-distinct colors. `analyzePixels`
bucketed pixels (quantize /12), sorted by pixel count, and `.slice(0, 50)` —
a pure popularity cut. On `docs/example_art/IMG_2953.jpg` the vivid flower-centre
yellow `#FDE384` (253,227,132) ranks **#126 by pixel count** (0.02% coverage), so
it was cut before the user ever saw it. No strong yellow survived the top-50.

Empirical (faithful pipeline, 320px, 22k samples): 290 raw buckets; busiest
example image (`viking_choir`) 441. So the top-50 slice was never a performance
floor — just an arbitrary cap.

## Fix

Replace the top-N slice with **color-distance clustering** (`clusterByColorDistance`,
in `PrototypeApp.tsx` next to `bucketPixels`):

- Walk buckets most→least common; keep each one that is ≥ `minColorDistance`
  (Euclidean RGB) from every already-kept color, else fold its pixels into the
  nearest kept color. No coverage cut.
- A small, distinct color survives because it is *far from everything else*,
  not because it is popular. Count-ordered so the dominant color in each
  neighbourhood is its representative. O(N·K) — scales past any bucket count,
  unlike the O(N³) `dedupNearestNeighbors` in core (that stays the finer,
  later Auto-combine pass).

`minColorDistance = 24` — just above the /12 quantization floor, same units as
the "conservative" auto-combine preset. Chosen for a rich-but-not-overwhelming
default (~39–45 colors on the example images) while keeping the vivid yellow crisp.
Threshold 20 → ~51 colors (finest), 30 → ~27 (yellow pales). Balanced (24) picked.

`paletteLimit` constant removed; the "Top 50 colors max" hero label is now
"By color difference". Auto-combine and both reset buttons are unchanged.

## Verification

- typecheck, `node --test` (55/57, 2 runtime-skips), static-export build — green.
- Headless Chrome on IMG_2953 through the real app: palette = **45 colors**, and
  the flower yellow **`#FCE27D` (252,226,125)** is present (was rank #126 / dropped
  before). Screenshot inspected.
