# Palette Survey from Original — Plan

Task summary: Rework `apps/web/app/PrototypeApp.tsx` so the palette/swatch survey runs against the **original uploaded image** at full natural resolution, then runs `classifyPaletteColors` automatically on upload so the user sees a classified palette by default — no top-N popularity cut, no manual button-press required to get a usable view. The sanitized + thumbnail pipeline stays exactly as-is and serves only persistence and visualization.

Smoking-gun symptom this plan fixes: the yellow flower-center disc in `docs/example_art/flowers.jpg` does not appear in the swatch selector. Simulation against the real file: largest yellow bucket ranks **68 of 381** at the post-double-downsample 320×206 survey grid, top-50 cut at `PrototypeApp.tsx:1777` drops it before `classifyPaletteColors` ever sees it.

## Background — two pipelines, two roles

Now formally separated by this plan:

- **Pipeline A — analysis.** `original File → loadImage(originalFile) → analyzeLoadedImage(originalImage at naturalWidth × naturalHeight) → buckets → classifyPaletteColors at "balanced" sensitivity → palette JSON (buys + mixes only)`. Runs **once** at upload time. Original pixels are the canonical color source. Fidelity is the only thing that matters here.
- **Pipeline B — persistence + visualization.** `original File → sanitizeUpload (longEdge 640 JPEG q=0.8) → sanitized JPEG + thumbnail JPEG → persisted`. Output is intentionally small and lossy — it exists so the user can recognize *which piece of art* they're working on and so the database row fits. Fidelity is not a constraint here.

These two pipelines must not share a "source pixels" buffer, and code must not assume one feeds the other.

## Selection model — what gets shown to the user

**The top-N popularity cut is gone.** Selecting palette members by raw `pixelCount` is what dropped the yellow accent — small saturated regions always lose the popularity contest to slightly-different shades of the dominant background. Replaced by:

1. **No upstream filter.** Every bucket the survey produces is passed to the classifier.
2. **`classifyPaletteColors` at "balanced" sensitivity (`residualThreshold: 36`) becomes the pre-filter.** Phase 0 dedup absorbs near-duplicates by Euclidean RGB distance; Phase 1 picks extremes (buys); Phase 2 classifies the rest as mix or absorb based on coverage.
3. **Only buys + mixes are visible.** `applyClassification` already removes absorbed entries from the rendered palette.

The Auto-combine button is no longer a "do the thing for the first time" action — it becomes a **"re-run classification at a different sensitivity"** action. The default upload palette is the balanced result; the user adjusts via Pro Settings sensitivity and re-runs to break out more accents (conservative) or collapse further (aggressive).

### Trial-run evidence (flowers.jpg, full-res survey, 500k samples → 520 buckets)

| sensitivity | threshold | Phase-0 survivors | buy | mix | visible swatches | yellow recovered? |
|---|---|---|---|---|---|---|
| conservative | 24 | 46 | 46 | 0 | **46** | yes |
| **balanced** *(default)* | **36** | **16** | **10** | **2** | **12** | **yes** |
| aggressive | 54 | 8 | 8 | 0 | 8 | (collapses) |

Balanced gives a clean 12-color default that includes the yellow accent. Conservative is available for accent-heavy images where the user wants more granularity.

## 1. Step-By-Step Plan

All file paths are in `apps/web/app/`.

### `PrototypeApp.tsx` — survey constants

1. Delete `const maxDimension = 320;` at `PrototypeApp.tsx:146`. The analysis canvas tracks `image.naturalWidth × image.naturalHeight` from now on.
2. Delete `function getScaledDimensions(...)` at `PrototypeApp.tsx:1812-1819` — unused after step 1.
3. Set `const maxSamplePixels = 500_000;` at `PrototypeApp.tsx:147`. Yields stride ≈ 14 on a 7-megapixel phone photo, which keeps small accents well-sampled while bounding survey CPU to <1 s. (Removing the cap entirely is the alternative; 500k is the chosen tuning per user discussion.)
4. **Delete `const paletteLimit = 50;` at `PrototypeApp.tsx:148` and the `.slice(0, paletteLimit)` at `PrototypeApp.tsx:1777` entirely.** Replaced by the classifier-as-pre-filter described below.

### `PrototypeApp.tsx` — `analyzeLoadedImage`

5. At `PrototypeApp.tsx:1748-1792`: drop the `getScaledDimensions(...)` call at line 1753 and set `canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;` directly.
6. Remove the `.slice(0, paletteLimit)` step inside `analyzeLoadedImage` (line 1777). The function returns **all** bucket entries (sorted by pixelCount descending, IDs assigned in that order), without a top-N cut.
7. `analyzeLoadedImage` does **not** run the classifier itself — it stays a pure "survey" function returning raw buckets. The classifier runs at the upload call site, where the sensitivity setting lives.

### `PrototypeApp.tsx` — the upload call site (the big rework)

8. At `PrototypeApp.tsx:669-688`, today's flow is `sanitizeUpload → analyzeBlob(sanitized) → snapshot canvas into sourcePixelsRef`. Rework to:
   ```
   const [analysis, { sanitized, thumbnail }] = await Promise.all([
     analyzeImage(file, canvasRef.current),     // Pipeline A: original pixels
     sanitizeUpload(file, limits)               // Pipeline B: persistence + viz
   ]);
   ```
   No sequential dependency between A and B.
9. Run `classifyPaletteColors` on the analysis output, using the user's current `proSettings.residualThreshold` (which defaults to `SENSITIVITY_PRESETS.balanced = 36` per `PrototypeApp.tsx:135, 140-141`). Apply via the existing `applyClassification` so absorbed entries drop out and pixel counts fold into keepers — same pipeline the Auto-combine button already uses at `PrototypeApp.tsx:876-933`. Populate `setPaletteColors`, `setClassifications`, `setMixRecipes` from the classified result.
10. The user-facing semantics of the Auto-combine button shift accordingly: it's now a **re-run at different sensitivity**, not a first-time "do the classification." Update its `title` tooltip at `PrototypeApp.tsx:1346` and any nearby copy to reflect this. Button stays in place; its behavior already supports this — it re-classifies whatever's currently in `paletteColors`.
11. `sourcePixelsRef` (used by the flatten-to-palette visualization at `PrototypeApp.tsx:376-404`) should be snapshotted from the **sanitized** image, not from the analysis canvas. This keeps the flatten viz cheap and matches the hydrated-project path at `PrototypeApp.tsx:588-602` which already snapshots from the sanitized image. Add a second offscreen canvas for the snapshot, or decode the sanitized blob a second time — whichever is simpler.

### `PrototypeApp.tsx` — collapse `analyzeBlob`

12. Delete `async function analyzeBlob(...)` at `PrototypeApp.tsx:1733-1746`, including the comment at lines 1733-1736 that rationalized the regression ("Same shape as `analyzeImage` but accepts a Blob — used after `sanitizeUpload` has re-encoded the upload into a capped JPEG so the palette reflects the stored pixels, not the user's original file."). It has no caller after step 8.
13. Replace with a one-line note above `analyzeImage` clarifying that this is the **only** palette-survey entry point and that it must always receive the original `File`.

### `PrototypeApp.tsx` — calibration comment at 128-132

14. The comment at lines 128-132 about "calibrated against the 12-per-channel quantization applied in analyzeLoadedImage" stays accurate — quantization is unchanged. No edit needed.

### Out of this plan

- `apps/web/app/uploadPipeline.ts` — untouched. `sanitizeUpload`, the cap constants, the magic-byte verifier, all the rest stays. Pipeline B is intentionally unchanged.
- `apps/web/app/editorPersistence.ts` — untouched.
- `packages/core` — untouched. The classifier and `applyClassification` are called with a larger candidate set, but their implementation is unchanged.
- `apps/api` and `packages/config` — untouched.

## 2. AGENTS.md Flag Check

Walking the "Flag before implementing" list at `AGENTS.md:57-69`:

- **Guest-mode write boundary.** N/A — this is a client-side analysis change. No new write path, no `session.kind` gate change.
- **CORS / public origins.** N/A — no network surface touched.
- **OAuth provider tokens.** N/A.
- **User-scoped brand data in repo.** N/A — analysis settings, not brand data.
- **Relational joins / non-document data model.** N/A — no API or data model change.
- **New public endpoint without validation/rate limiting.** N/A — no new endpoint.
- **Bypass upload validation.** N/A — `sanitizeUpload` and its magic-byte / size / format checks run unchanged (Pipeline B). The new analysis path uses `<img>` decoding of the same file the user picked; no validation is being skipped. The server-side `apps/api/src/imageValidation.ts` still validates whatever the client uploads.

No flags fire.

"Read before editing" relevant entries from `AGENTS.md:18-26`:
- **Touching estimation, palette merging, or paint math → read `packages/core` before writing.** We're not editing `packages/core`, but we are changing **how it's called** (auto-running classification on upload, larger candidate sets). Re-read `packages/core/src/index.ts:444-755` (`classifyPaletteColors`, `dedupNearestNeighbors`, `findBestMixingPair`, `projectOntoSegment`, `applyClassification`) before implementing step 9 — already done as part of this plan.

"Do not touch without explicit instruction" at `AGENTS.md:71-77`: none of the listed paths are in scope.

## 3. Ambiguity Check

Resolved during this session:

- **"Yank the maxDimension cap" interpretation:** removed entirely. Survey runs at `naturalWidth × naturalHeight`. Device-floor caps are explicitly out per `feedback_no_low_ram_hand_wringing.md`.
- **Replacement for `paletteLimit`:** classify-on-upload at balanced sensitivity, no top-N. User-confirmed during planning ("we can't pre-filter exclusively by pixel counts").
- **`maxSamplePixels`:** capped at 500k. User-confirmed.

Ambiguity check: none remaining for the core change.

## 4. Verification Approach

- `npm run typecheck` — applies. `analyzeBlob` removal could leave dangling imports/refs; typecheck will catch them. New call-site shape (`Promise.all` + classify-and-apply) will exercise types around `ClassifyPaletteInput`, `ClassifiedColor`, and the existing `applyClassification` return.
- `npm run test` — applies. The existing test `"classifyPaletteColors keeps a lone off-line accent as buy"` in `packages/core/test/index.test.ts:506-518` should still pass — we did not touch `packages/core`.
- `npm run build` — applies. Static export must still produce.
- `npm run lint` — applies. No new lint surface, but standard pass.
- **Manual repro against `docs/example_art/flowers.jpg`.** Start dev server, upload `flowers.jpg`, confirm the default palette has ~12 swatches including a visible yellow tile. No Auto-combine click should be required.
- **Manual sensitivity sweep.** Open Pro Settings, switch sensitivity (conservative / balanced / aggressive), click Auto-combine, confirm the palette recomposes per the trial-run table above.
- **Manual check against `docs/example_art/winding-path-9840681_640.jpg`.** Sanity-check the palette doesn't regress on a simpler image.
- **Manual check that pipeline B output is unchanged.** Upload, look at the in-app preview and verify the sanitized image still renders. Open `/projects`, confirm the thumbnail tile still looks right.

Since this is user-visible UI behavior per `AGENTS.md:83-94`, ship-it means CI green on a feature branch PR **plus** a live preview URL that demonstrates the yellow swatch on `flowers.jpg`.

## 5. Open Questions

1. **Default sensitivity** is set to `proSettings.residualThreshold` which is "balanced" (36) by default. If a returning user already has a different sensitivity persisted (e.g., they previously set "conservative"), uploads will use that on first analysis. Acceptable — sensitivity is already a user-tunable setting per Pro Settings. No special-casing needed.
2. **`sourcePixelsRef` source** — plan assumes sanitized snapshot for the flatten viz (cheaper, consistent with hydrated projects). Confirm during implementation if the resulting flatten preview looks visibly worse on accent-heavy images; if so, switch to full-res original.
3. **Test artifact.** Should the Python simulation become a checked-in unit test (likely in `apps/web` since the survey lives there)? Probably yes as a follow-up PR, not in this one — would need to extract the survey logic into a testable pure function first.
4. **Auto-combine button copy.** Plan calls for updating the tooltip at `PrototypeApp.tsx:1346`. The exact wording is a small UX call to make during implementation — current text is "Classify the palette into colors to buy, colors to mix, and gradient members to absorb into their nearest neighbors." It's still accurate but the framing ("Classify" implies first-time action) could shift to "Re-classify at current sensitivity" or similar. Out-of-scope wordsmithing; pick something reasonable during implementation.
