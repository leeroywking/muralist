# Crop to Wall Ratio — Plan Stub

Task summary: Give muralists a crop workflow they can open from the top of the page to re-frame uploaded artwork to the entered wall aspect ratio. Two user intents: (a) reconcile a mild ratio mismatch (close-but-not-exact) by shifting the crop within the original image, (b) pick an arbitrary rectangle of the source as the intended mural artwork.

**Status:** plan captured, not scheduled. Logged so it is not lost while other work proceeds.

## Motivation

- Today, a wall aspect ratio that does not match the uploaded art stretches the reduced mural preview and triggers `aspectRatio.shouldWarn`. The user's only remedy is re-uploading a cropped file offline.
- Cropping inside the app preserves the source bytes, keeps the palette analysis consistent with what will be painted, and removes the ratio-mismatch warning at its source.
- Depends on: `apps/web/app/PrototypeApp.tsx` palette + preview pipeline, `apps/web/app/maquettePdf.ts` art row, and the `FieldSheetModel.sourceSize` / ratio reporting that landed with the scaled-grid PR.

## 1. Step-By-Step Plan

### `packages/core`

1. Add pure helpers to `packages/core/src/index.ts`:
   - `deriveLargestRectForAspect({ sourceWidthPx, sourceHeightPx }, targetAspectRatio)` → returns `{ widthPx, heightPx }` for the largest rectangle inside the source that matches the target aspect ratio. Used as the crop box's initial sizing.
   - `clampCropRect(rect, sourceSize, targetAspectRatio)` → keeps a user-moved crop rectangle fully inside the source bounds and locked to the target aspect ratio.
   - `CropRect = { xPx: number; yPx: number; widthPx: number; heightPx: number }` — pixel-space rectangle, top-left origin.
   - Both helpers stay I/O-free per `packages/core` purity.

2. Tests in `packages/core/test/index.test.ts`:
   - Largest inscribed rect for wider-source / narrower-target and vice versa.
   - `clampCropRect` enforces aspect ratio when the user drags a corner.
   - `clampCropRect` keeps the rect inside the source when the user pans past the edge.

### `apps/web`

3. Add `Crop to wall ratio` control near the upload/preview area in `apps/web/app/PrototypeApp.tsx`. Visible once an image is uploaded; disabled until a valid wall width/height has been entered. The control opens an inline crop editor — not a modal — to keep the flow flat.

4. Crop editor in `apps/web/app/PrototypeApp.tsx` (or a new component file under `apps/web/app/` if it grows past ~150 lines):
   - Shows the original source image at fit-to-container size.
   - Draws a rectangle overlay locked to the wall aspect ratio (from `wallLength` / `wallWidth` inputs) with corner handles for zoom and a whole-rect drag handle for pan.
   - Buttons: `Apply crop`, `Reset to full image`, `Cancel`.
   - While the editor is open, the rest of the workflow (palette, field sheet, PDF button) reflects the un-cropped source.

5. On `Apply crop`:
   - Draw the cropped rectangle from the *original* source bytes onto an offscreen canvas (max edge capped like the analysis pipeline at ~320 px for re-analysis, ~1200 px for PDF embedding).
   - Use the canvas output as the new working image: replace `previewUrl` / analyze pixels through the existing `analyzeImage` path so palette coverage percentages reflect the actual paint area.
   - Record the crop rect in state so `Reset to full image` can undo without re-uploading.

6. On `Reset to full image`:
   - Restore the originally-uploaded bytes (kept in a `sourceBytesRef`).
   - Re-run analysis. Warn the user if they have merged / pro-combined since cropping — offer `Save Merge Choices` before reset.

7. PDF layout implication in `apps/web/app/maquettePdf.ts`:
   - No code change required — the PDF reads `originalImageUrl` and `reducedImageUrl` from state, which after crop point at the cropped image.
   - Consider adding a small `cropped from {origW}×{origH}` note under the art panel if the source was cropped; defer unless reviewers ask.

### Not touched

- `apps/api/**`, `apps/mobile/**`, `packages/config/**`.
- `.github/workflows/**`, `package.json` scripts, `tsconfig*.json`, `apps/web/next.config.mjs`.
- `suggestContainersForColors` — palette coverage re-derives from re-analysis.

## 2. AGENTS.md Flag Check

- Guest-mode persistent write boundary: **N/A** — browser-local only.
- Upload validation: **applies**. Cropping runs *after* the existing \`image/*\` + 15 MB gate; do not relax. If a cropped canvas export is stashed in state, treat it as trusted in-browser bytes (already decoded by the user agent).
- Committed user data: do not commit sample cropped outputs or original upload bytes into the repo.
- `packages/core` purity: **applies** — crop math stays pure; canvas rasterization stays in the web layer.
- CORS / OAuth / DynamoDB / public endpoint / rate limiting: **N/A**.
- Hands-off surfaces: **not touched**.

## 3. Ambiguity Check

Meaningful ambiguity: **when does the crop affect palette analysis?**

- Option A (recommended): cropping re-runs analysis so the palette, coverage %, and container plan reflect only the cropped pixels. Matches what the muralist will paint. Requires holding the original bytes in state so `Reset to full image` can undo.
- Option B: cropping is cosmetic only — palette analysis keeps using the full source, PDF art panels show the cropped rect. Simpler but coverage % is wrong; muralists buy paint for pixels outside the mural.

Plan chooses Option A. Option B is only worth considering if re-analysis turns out to be slow enough on large images to hurt the UX; if so, offer a toggle rather than dropping correctness.

Secondary ambiguity: **inline crop editor vs modal**. Plan chooses inline to keep the flow flat and avoid a modal focus trap; modal is fine if inline becomes too cramped on narrow viewports.

## 4. Verification Approach

After implementation:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run lint`

Manual on the Pages preview:

- Upload a 4:3-ish source (e.g. `docs/example_art/winding-path-9840681_640.jpg`), set wall to `16 × 4` ft.
- Confirm the ratio warning banner appears with the full image.
- Open `Crop to wall ratio`. Confirm the crop rectangle initial-sizes to the largest 16:4 rect inside the source.
- Pan the rectangle, zoom to the crop region the artist wants, click `Apply crop`.
- Confirm the ratio warning disappears, the reduced mural preview no longer looks stretched, and the palette coverage % has rebalanced to the cropped pixels.
- `Reset to full image` restores the un-cropped source and re-runs analysis.
- Download the PDF and confirm the art row reflects the cropped image, not the stretched-to-wall view.
- Re-run the Playwright harness at \`~/.local/share/playwright-tools/exercise-maquette.mjs\` with a step that opens the crop editor, applies a crop, then downloads the PDF.

## 5. Open Questions

1. **Handles-and-aspect lock UX:** does dragging a corner zoom the rectangle uniformly while keeping the wall ratio, or does the user pick between "move" and "resize" modes? Plan assumes uniform-scale handles.
2. **Image storage cost:** the original bytes must stay in memory while the crop is active so Reset is instant. For a 15 MB upload that is fine; document this behavior so it is not a surprise later if we expand the upload cap.
3. **Discoverability:** the control is near the top, always visible after upload. Should we also auto-focus the crop button when `aspectRatio.shouldWarn` flips true, nudging the user toward it? Plan defers; this is a UX-polish follow-up.
4. **Mobile support:** touch drag / pinch-to-zoom on the crop editor. Plan defers; desktop-first implementation is fine for the first pass.
5. **PDF "cropped from" annotation:** worth adding a small "cropped from N×N" note in the PDF art caption, or leave the PDF silent about the crop? Plan defers until reviewers request it.
