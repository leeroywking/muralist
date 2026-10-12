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

## Color lock (2026-10-12)

**Why.** Auto-combine folds small detail colors into their neighbors — on the octopus image the light-pink suckers (`#FDB2C0`, ~3.6%) absorb into tan at Balanced. Users asked to "lock colors so they can't be merged or mixed, to preserve small details — lock colors before the auto-merge."

**Origin.** Ported from PR #12 (`feat/unmerge-colors`, commit `aec1f75`), which bundled a per-color Lock with art-tap pull-out. Only the lock was taken: the `locked?: boolean` palette flag and its persistence (`apps/web/app/editorPersistence.ts`, `apps/web/app/apiClient.ts`), the API schema field and its two tests, and the chip Lock toggle + 🔒 badge (restyled to the monochrome tokens). PR #12's classifier change targeted the old RGB classifier, so the core logic was rewritten for the OKLab classifier on this branch. Art-tap, the loupe, the worker, disable, and classify-on-upload were not ported, and the PR stack (#10/#11/#12) was not merged.

**Classifier (`packages/core`, `classifyPaletteColors`).** New optional `lockedIds?: ReadonlySet<string>`; omitted = previous behavior.
- A locked color is always `buy`: never absorbed, never a mix target, never demoted in the settle pass.
- Locked colors are seeded into the buy set before the coverage-ordered greedy pass, so they are available as partners regardless of coverage. Unlocked colors may mix with a locked partner (the usual partner-coverage ratio still applies) and may absorb into it.
- Near-duplicate dedup (Phase 0): a locked color is never the absorbed member. With exactly one locked member of a pair, the unlocked member absorbs into the locked one — unless the unlocked member is dominant (≥ the dominant cutoff), in which case both stay. Two locked colors never merge.
- Existing invariants hold: absorb and mix targets are always buy colors, no chains.

**Web (`apps/web/app/PrototypeApp.tsx`).**
- Each chip has a Lock toggle (`aria-pressed`) and a 🔒 badge on the swatch when locked.
- Auto-combine passes the locked ids to the classifier. Locked flags ride on the palette color, so they survive Auto-combine, Merge Selected (keeper), save/load (account and on-device), and **Reset to original colors** (carried onto the restored colors).
- **Merge Selected:** a locked chip can be the keeper (it absorbs the others and stays locked), but it cannot be merged away. If a selected non-keeper is locked, the merge is refused with a short message.
- **Full reset** re-derives the palette from the image pixels and clears all locks (it is a full reset).
- Known limitation: Auto-combine re-classifies the already-combined palette (separate bug, not fixed here). To lock a color that has already been merged away, press "Reset to original colors" first, lock it, then Auto-combine.

**Persistence.** `paletteColorSchema` gains `locked: z.boolean().optional()`. The schema is a non-strict `z.object`, so before this change a `locked` key was silently stripped on save, not rejected. Unlocked colors omit the key.

## Variant B sunset (2026-10-12)

Variant B (`feat/mix-spectral`, PR #14) is closed. Real-art testing on the five test images (`docs/example_art/{Coral,FlowerRepeat,KillerFrosting,Mazdarati}.jpg`, `feedback/IMG_3043.jpg`) showed Variant A was more reliable. B picked black/white as partners on Mazdarati, gave implausible recipes on the octopus at Aggressive, and ran about 8x slower. Instead of a pigment model, paint plausibility now comes from the explicit checks below. Variant A (`feat/mix-oklab`, PR #13) is the one going forward.

## Paint-plausibility checks, distinct small colors, Auto-combine snapshot (2026-10-12)

**Paint plausibility (`packages/core`, `isPlausibleMix`).** Every candidate pair in `findBestMixingPair` must pass these rules. That function is the only place a color is judged "on a line between two buy colors": the greedy, settle and classify passes all use it. The rules are evaluated in OKLCh, and the tolerances are justified at their constants:
- Chroma ceiling: C(T) ≤ max(C(P1), C(P2)) + 0.012. None of the 84 CSV sRGB-lerp steps exceeds the ceiling.
- Value bracket: L(T) stays within the partners' L range ± (0.02 + 0.2 × the partners' mean chroma). sRGB midpoints of two saturated colors come out lighter in OKLab: up to 0.054 on CSV "Bright Red to Royal Blue".
- Hue. Partners with C < 0.025 count as neutral, and a target with C < 0.025 skips the hue check.
  - Two neutral partners never make a chromatic target.
  - With one neutral partner, the target's hue must be within 20° of the chromatic partner's hue. sRGB tints drift by up to 15°, as on CSV "Indigo to white".
  - With two chromatic partners, the target may not exceed the partners' chroma interpolated at the recipe fraction + 0.012. If the partners are less than 150° apart in hue, the target must also lie on the shorter hue arc between them, with up to 0.008 of slack on the a/b plane.
  - Near-complements (≥ 150° apart) skip the arc test, and the interpolated-chroma bound is what makes them dull toward grey. The literal "below both partners' chroma" rule was not used, because CSV sRGB lerps break it near the saturated end.
- Regression case: on FlowerRepeat, dark yellow `#F5C233` is no longer "7% navy + 93% light yellow". At Conservative and Balanced, light yellow is now 23% white + 77% dark yellow. At Aggressive, the two yellows are 0.049 apart and dedup into light yellow.

**Distinct small colors.** A color below `mixCoveragePercent` that fits a line is absorbed into the nearer endpoint only when either of these holds:
- It is within `2 × residualThreshold` (OKLab) of that endpoint.
- It covers under 1% of the image. These are anti-aliasing seams: at ≤ 22,000 samples, a full-width 1-px seam is about 1.5%, split over at least two blend buckets.

Otherwise the color stays buy. The rule is applied inside the greedy and settle passes as well, so the result stays coherent. The octopus suckers `#FDB2C0` (3.2–3.6%, 0.17–0.18 from both pink and white) now stay buy at Balanced with a 5% mix threshold.

Phase-0 near-duplicate dedup is capped at an OKLab distance of 0.05 (2.5 JND). At Aggressive (0.07), dedup used to merge Coral's flat red `#D93A48` into the magenta `#DA246D`, which is 0.065 away. With the cap, the red is a mix (77% `#DA246D` + 23% `#EDA93C`) instead of being dropped.

**Auto-combine snapshot (`apps/web/app/autoCombine.ts`, `PrototypeApp.tsx`).** Previously, Auto-combine re-classified the palette that a previous Auto-combine had already shrunk and re-weighted. As a result, Aggressive → Conservative did not get back to the Conservative result. Now:
- The first Auto-combine snapshots the palette, including manual merges and lock flags.
- Every later Auto-combine re-classifies from that snapshot, taking lock flags from the current chips. Transparent flags are keyed by id, so they carry over.
- Merge Selected, Reset to original colors, Full reset, a new upload, and loading a project or restoring saved choices all clear the snapshot. The next Auto-combine then snapshots the edited palette.
- The snapshot is not persisted. After a save and load, the first Auto-combine starts from the loaded palette, which may already be combined.
- If nothing combines at the chosen setting, the snapshot palette is shown unchanged.

## Background colors and mixing (2026-10-12)

Bug: a color marked as background (bare wall, no paint) was still available to Auto-combine. It could be a mix partner (FlowerRepeat's light yellow came back as "white + dark yellow" with the white marked as wall), be mixed itself, or be absorbed into another color and lose its background flag. Separately, `adjustedCoverage` in `apps/web/app/PrototypeApp.tsx` passed every recipe to `applyMixesToCoverage` over the paintable palette (background excluded); one recipe using a background color threw, and the catch fell back to raw coverage, silently dropping *all* mixes from the estimate.

Core (`classifyPaletteColors`, new `backgroundIds` option, backward compatible):

- A background color is never a mix partner: no recipe lists it as a component. If it is also locked, background wins.
- Like a lock, it is always buy (in the classifier's sense) — never a mix target, never absorbed into another color, so it keeps its flag.
- Its own near-duplicates still fold into it in the Phase 0 dedup (paper grain / wall texture noise collapses into the bare wall), even when the near-duplicate is the larger chip.
- Sub-1% edge pixels on a line between the background and a paint color still absorb into the nearer endpoint (the anti-aliasing seam), but only when they would be absorbed anyway (coverage below the mix threshold). At mix threshold 0 nothing absorbs, and a wall + paint recipe is not possible, so such a pixel stays buy.
- A paint color that could only be explained as "X + background" takes the normal no-fit path (buy).
- Coverage stays whole-image-relative: background pixels still count in the denominator for the dominant, mix-coverage and edge thresholds. That matches the editor (coverage percentages are of the whole image, and the paint plan drops background colors without renormalising), so toggling a background never shifts the other colors across a threshold.

Web: Auto-combine passes the background set (it is keyed by color id, so the pre-combine snapshot path needs nothing extra). Marking a color as background *after* an Auto-combine drops the recipes that use it (or mix it) and makes their targets buy, with a message suggesting another Auto-combine; it does not silently re-run classification, which could change the palette under settings the user has not applied. `applyValidMixesToCoverage` (in `apps/web/app/autoCombine.ts`) skips only recipes whose target or components are not in the paintable palette.

Tests: `packages/core/test/index.test.ts` (background never a partner/target/absorbed across presets, thresholds and dominant settings on the teal, FlowerRepeat and greys palettes, locked or not; FlowerRepeat light yellow not made from background white; near-duplicates fold into the background; edge pixels absorb into it at mix 5% and stay buy at 0%) and `apps/web/app/autoCombine.test.ts` (Auto-combine with background ids, `dropRecipesUsingColor`, `applyValidMixesToCoverage`).

## Browser-independent analysis (2026-10-12)

**Rule (user):** "I don't want the browser-modified file in our key path at all. If what is rendered to the user contains privacy noise that's fine, as long as we aren't running calculations against it." No calculation — palette survey/clustering, classification input, coverage, reduced-preview flattening, anything that feeds the estimate or maquette — reads pixels from a browser canvas, ImageBitmap or `<img>` readback. Canvas is display-only.

**Why.** The same file gave three different palettes: FlowerRepeat came out as `#FAF0F0/#45AFB1/#F9D45D` in one user's browser, `#FAFBFB/#45B0B3/#F9D55F` in headless Chrome, and `#FCEFF1/#63ACB1/#F2D66D` in Firefox. There were four causes:
- FlowerRepeat, Coral and the octopus are Procreate exports with an embedded Display P3 ICC profile, and browsers color-manage them differently. Firefox's `#63ACB1` is the raw, unconverted P3 teal.
- `drawImage` from 3000 px down to `maxDimension` uses a resampling filter that differs per browser.
- Privacy canvas noise (Safari AFP, Brave, Firefox RFP) randomizes `getImageData`.
- JPEG decoders round differently.

**Pipeline** (`apps/web/app/imageAnalysis.ts` → `@muralist/core`). It runs in a Web Worker (`analysisWorker.ts`, created by `analysisClient.ts`) and reads the original file's bytes:
1. **Decode it ourselves.**
   - JPEG: `jpeg-js@0.4.4` (BSD-3-Clause).
   - PNG: `fast-png@8.0.0` (MIT; brings `fflate` and `iobuffer`, both MIT). Handles any bit depth, gray, indexed and tRNS.
   - WebP: `@jsquash/webp@1.5.0` (Apache-2.0, libwebp WASM). Loaded lazily; webpack emits the `.wasm` under the basePath. Verified in the static export, in a worker, in Chrome and Firefox.
   - Exact versions are pinned in `apps/web/package.json`.
2. **ICC → sRGB** (`packages/core/src/icc.ts`). The ICC profile comes from the JPEG APP2 `ICC_PROFILE` chunks (reassembled in order), PNG `iCCP` (inflated by fast-png) or the WebP `ICCP` chunk.
   - Supported: generic matrix/TRC RGB profiles, i.e. `rXYZ/gXYZ/bXYZ` plus `rTRC/gTRC/bTRC` as `curv` (identity, gamma or table) or `para` (types 0–4). That covers Display P3, Adobe RGB, ProPhoto and sRGB.
   - The colorants are D50 PCS values. Old v2 profiles whose colorants sum to their media white rather than D50 are first Bradford-adapted from that white to D50.
   - XYZ(D50) → linear sRGB uses the Bradford-adapted sRGB matrix. Rendering is relative colorimetric with hard clipping.
   - Encoding back to 8 bits uses exact threshold tables, so it is deterministic.
   - A profile that is sRGB in all but name passes pixels through unchanged.
   - Untagged images are treated as sRGB.
   - Unsupported profiles (LUT-only, CMYK, gray, Lab PCS) are treated as sRGB, with a small non-blocking note under the upload.
3. **Downscale ourselves** (`packages/core/src/raster.ts`, `downscaleBoxRgba`).
   - Area-average (box) filter with exact fractional coverage. Source and target are mapped onto a common integer grid, so every overlap weight is an integer.
   - Colors are averaged alpha-weighted, with all sums exact in IEEE doubles (below 2^53 up to about 100 MP), then rounded half up. The result is bit-identical in every engine.
   - The analysis size keeps the old `maxDimension` semantics: long edge 320, never upscaled, same rounding. PR #10 (`feat/palette-survey-from-original`, not merged) explored surveying at full resolution; this change keeps 320 so the classifier's coverage calibration is unchanged.
4. **EXIF orientation** (JPEG APP1, and WebP `EXIF`). It is applied after the downscale, which is exact because a box filter commutes with flips and transposes. This matches the browsers' `image-orientation: from-image` geometry for the reduced preview. PNG `eXIf` is not applied.
5. **Survey** (`packages/core/src/palette.ts`, `surveyPalette`). Moved verbatim from `PrototypeApp.tsx`, so the clustering math is unchanged.

**Downstream changes:**
- `sourcePixelsRef` holds these pixels. Full reset re-surveys the same pixels.
- The reduced preview / maquette image is `flattenPixelsToPalette` (core), encoded to PNG with fast-png. There is no `toDataURL` readback.
- A re-opened project decodes its stored sanitized JPEG with the same pipeline (pixels-only mode).
- The analysis input is now the original upload, not the 640 px sanitized JPEG. That restores "palette extraction reads from the original upload only".

**Display/persistence canvases.** `uploadPipeline.ts` still re-encodes the sanitized and thumbnail JPEGs on a canvas. It now explicitly requests `getContext("2d", { colorSpace: "srgb" })` and `createImageBitmap(file, { colorSpaceConversion: "default" })`. These artifacts are never analysis inputs.

**SVG is the one remaining exception.** No browser-free SVG rasterizer exists without a heavy dependency, so SVG keeps the isolated-`<img>` rasterize and an sRGB canvas readback (`analyzeSvgViaCanvas` in `analysisClient.ts`). Its palette can differ slightly between browsers; a test file gave `#EFBF41` in Chrome and `#EFBF40` in Firefox. Proposed follow-up: `@resvg/resvg-wasm` (MPL-2.0, a multi-megabyte WASM, loaded lazily for SVG only).

**Worker.** `new Worker(new URL("./analysisWorker.ts", import.meta.url))` is written inline. PR #12's module worker failed on the static export because it built the URL in a separate variable, so webpack shipped the raw `.ts` file as an asset. With the inline form, webpack emits a JS chunk under the basePath. This avoids PR #12's Blob-URL workaround, which duplicated the code as a string. There is no main-thread fallback, so a broken worker build fails loudly. `window.__muralistAnalysis` records `{ via, format, color, timingsMs }` for verification.

**Tests:**
- `packages/core/test/imageAnalysis.test.ts`:
  - P3 primaries clip to sRGB primaries, and P3 white, black and greys stay neutral.
  - In-gamut colors match an independent D65 reference to ±1.
  - Determinism, and every 8-bit sRGB value round-trips.
  - sRGB-profile identity detection, `curv` gamma and table curves, legacy unadapted v2 colorants, and unsupported profiles left untouched with a note.
  - JPEG and WebP metadata parsing, box downscale exactness, all 8 orientations, and downscale/orientation commutation.
  - The full pipeline on a P3-tagged synthetic image, through to classification.
- `apps/web/app/imageAnalysis.test.ts`:
  - JPEG, PNG and WebP are encoded in-test, with the authored P3 profile embedded.
  - Byte-identical palettes across runs, with exact expected values.
  - Auto-combine is identical at Balanced/5% and Aggressive/0%.
  - The analysis modules use no canvas, ImageBitmap or `<img>`. The suite itself runs in Node, which has no DOM.
- The P3 profile is authored in-test (`packages/core/test/iccProfileBuilder.ts`, fixture `display-p3-authored.icc`). The user's artwork is not committed.
- `npx tsx apps/web/scripts/analyze-file.ts <image>` runs the exact production pipeline in Node, to compare against the app.
