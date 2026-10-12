# Plan: Mix-Recipe Accuracy (two variants for side-by-side testing)

**Status:** in progress (2026-10-12). Two preview branches are built so testers can compare.

**Source:** "Mixing Issues 9/16/26" pages of `feedback/Muraliste Development.pdf`, plus `feedback/IMG_3043.jpg` (octopus test image).

## Problem

`classifyPaletteColors` in `packages/core/src/index.ts` produces mix recipes a painter cannot make:

- Light teal `#92D8D7` = 74% `#FFFFFF` + 26% `#020F1A` (white + black makes grey, not teal).
- Purple `#390E5D` = white + near-black (you can't get purple from black).
- The octopus's dominant pink (about 28% coverage) is turned into a mix of light pink + sky blue.
- On the boat image, a rarely used indigo is chosen as a mix partner over a closer, more common color.
- Layered tint mixes in the sunset image are not detected at all.

### Root cause (verified against the code)

1. **Circular disqualification.** Phase 1 marks a color "extreme" (eligible as a mix partner) only if no two *other* survivors bracket it. `#3BB5B2` ≈ white + `#038D8C` (residual 16.2) and `#038D8C` ≈ `#3BB5B2` + `#020F1A` (residual 40.8). On Aggressive (threshold 54) each teal disqualifies the other, so neither can be a partner. `#92D8D7` then falls back to white + black (residual 52.9 < 54), even though white + `#3BB5B2` fits at residual 3.1. Both teals still end up as "buy" in Phase 2, because nothing fits them against the reduced extreme set. The result is internally incoherent.
2. **Coverage is ignored for buy status.** A 28%-coverage color becomes a mix whenever any two minor colors bracket it.
3. **Coverage only breaks ties.** Partner choice is by lowest residual; partner coverage only matters within 1e-6.
4. **Distances are in sRGB.** A fixed RGB threshold means different perceptual tolerances in darks vs lights, and there's no perceptual hue check.

## Shared fix (both variants)

All of this lives in `packages/core` and stays pure (no I/O).

- **Greedy, coverage-ordered buy set.** Replace Phase 1/2 with: after near-duplicate dedup, process survivors in descending coverage. Each color is tested against the *current* buy set. If it fits as a mix of two buy colors, classify it as mix (coverage ≥ `mixCoveragePercent`) or absorb (below). Otherwise it joins the buy set. Common colors therefore become partners first, and partners always come from the final buy set (no circularity).
- **Dominant colors are always buy.** Any color at or above a dominant-coverage threshold (default 15%, exposed as an option) is never a mix or absorb target.
- **Partner preference.** Among pairs that fit under the threshold, prefer the pair whose less-used partner has the higher coverage, unless another pair's residual is clearly better. Pick the exact scoring rule and document it in code.
- **OKLab measurement.** Add `rgb → OKLab` conversion to core (Björn Ottosson's published formula, no dependency). Dedup distance and mix-fit residuals are measured as OKLab Euclidean distance. Re-calibrate the Conservative / Balanced / Aggressive presets in `apps/web/app/PrototypeApp.tsx` (currently 24 / 36 / 54 RGB units) to OKLab equivalents, and document the calibration.

## Variant A — `feat/mix-oklab`

The shared fix only. The mix path is the straight sRGB line between two buy colors, because digital gradient tools interpolate in sRGB. `t` is the projection in sRGB, and the residual is the OKLab distance between the candidate and the sRGB point at `t`.

## Variant B — `feat/mix-spectral` (branched from A)

Variant A plus a pigment path using `spectral.js` (MIT, v3.x, the Kubelka–Munk model) as a dependency of `@muralist/core`. For each candidate pair, also sample the pigment mix curve across `t ∈ [0, 1]` and take the OKLab distance to the closest sample. Accept the fit from either path (RGB line for digital art, pigment curve for painted/layered art), whichever has the lower residual. The recipe fractions come from the winning path. Mixbox is **not** used (CC-BY-NC-4.0, non-commercial only).

## Out of scope

- Disable-mixing toggle and sq ft on chips (backlog, `ROADMAP.md` 2026-10-12 update).
- The preview hue-shift bug (dark red rendering as green) in the reduced mural preview, which comes from nearest-palette mapping, not mix math.
- Open PRs #10–#12. Both variants branch from `main`.

## Verification

- Unit tests in `packages/core/test/index.test.ts` must cover at least:
  - The teal palette from the PDF (`#FFFFFF 50.7%`, `#92D8D7 21.4%`, `#038D8C 8.9%`, `#390E5D 6.9%`, `#FAD678 6.0%`, `#020F1A 3.3%`, `#3BB5B2 2.7%`, `#C1A76C 0.1%`) at every preset: `#92D8D7` is never white + black, and `#390E5D` is never a white/black mix.
  - A dominant color is never classified mix or absorb.
  - A synthetic sRGB gradient between two colors is still detected.
  - Variant B only: a synthetic pigment-mix gradient (generated with spectral.js) is detected.
- `npm run typecheck`, `npm run test`, `npm run build`, `npm run lint` from the repo root.
- PR per variant, CI green, and the Pages preview at `https://leeroywking.github.io/muralist/previews/<slug>/` actually loads. Test plan: upload the octopus / teal-boats / sunset images, press Auto-combine at each sensitivity, and check the recipes.
