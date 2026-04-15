# Client-Side Maquette PDF Plan Stub

Task summary: Replace browser `window.print()` maquette output with a true client-side PDF download so Muralist controls filename, margins, pagination, swatches, and removes browser URL/date headers.

## 1. Step-By-Step Plan

1. Add a deliberate web PDF dependency in `apps/web/package.json`.
   - Preferred first choice: `pdf-lib`, because it can generate deterministic PDFs in the browser without a backend.
   - Alternate: `@react-pdf/renderer` if the implementing agent wants React-style PDF layout instead of drawing commands.
   - This is a dependency-version change, so keep it scoped to this feature and do not update unrelated packages.

2. Add a PDF generation module under `apps/web/app/`.
   - Suggested file: `apps/web/app/maquettePdf.ts`.
   - Export one function such as `downloadMaquettePdf(input)`.
   - Inputs should come from the existing `FieldSheetModel`, `originalImageUrl`, and `reducedImageUrl` in `apps/web/app/PrototypeApp.tsx`.
   - Do not read from the DOM as the source of truth; use the same field-sheet data model that powers the web preview.

3. Replace or supplement the current print button in `apps/web/app/PrototypeApp.tsx`.
   - Current behavior: `handlePrint()` mutates `document.title` and calls `window.print()`.
   - Target behavior: a button labeled `Download Maquette PDF` calls the client-side PDF generator.
   - Keep `Print / Save PDF` only as a fallback if needed, but the primary review path should be the generated PDF.

4. Use the existing maquette filename helper.
   - Reuse `buildMaquetteFileName()` from `packages/core/src/index.ts`.
   - Downloaded file should be `<uploaded-artwork-base>_maquette.pdf`.
   - Existing tests in `packages/core/test/index.test.ts` already cover the base filename helper.

5. Implement the PDF layout directly.
   - Page target: US Letter portrait unless the product direction changes.
   - Do not include browser URL, date, page title, or page number headers/footers.
   - Top section: original artwork and reduced mural preview side by side.
   - Middle section: empty artist workspace on the left two-thirds, swatches and estimates right-aligned on the right third, with dividers extending through the empty workspace.
   - Bottom section: artist notes from the textarea, then total package/volume/price.
   - Preserve color swatches using direct PDF fill color, not CSS background behavior.

6. Handle images explicitly.
   - Convert `originalImageUrl` and `reducedImageUrl` into image bytes.
   - Embed JPEG/PNG where possible.
   - If an uploaded format cannot be embedded directly, draw it to a canvas and export PNG bytes before embedding.
   - Preserve the source artwork aspect ratio in the original view.
   - Fit the reduced mural preview to the entered wall aspect ratio.

7. Keep the web preview and PDF unified by data, not by browser print.
   - The web preview may remain HTML/CSS.
   - The PDF should not scrape the HTML preview.
   - Both outputs must use the same `FieldSheetModel` values for colors, quantities, notes, wall dimensions, grid size, ratio warning, and totals.

8. Add tests where practical.
   - Keep pure filename/grid/ratio tests in `packages/core/test/index.test.ts`.
   - Add a focused unit test for any pure PDF layout helpers if extracted, such as page-section measurement or color conversion.
   - If binary PDF output is hard to assert, document manual verification in the PR test plan rather than adding brittle byte snapshots.

## 2. AGENTS.md Flag Check

- Dependency versions: applies. This plan requires adding a PDF library dependency. Keep it scoped and do not bump unrelated dependencies.
- Guest-mode persistent write boundary: does not apply if the PDF is generated locally in the browser and not saved to a server.
- CORS widening: does not apply. Do not modify `apps/api/src/server.ts` CORS settings.
- OAuth provider tokens: does not apply.
- Committed user data: does not apply. Do not commit uploaded images or generated PDFs.
- New public endpoint: not planned. If an endpoint is introduced, stop and add validation plus rate limiting.
- Upload validation: current browser file validation still applies. Do not bypass it.

## 3. Ambiguity Check

- PDF library choice is open. Build with `pdf-lib` unless there is a strong implementation reason to use `@react-pdf/renderer`.
- Browser print fallback is optional. Prefer replacing the primary button with generated PDF download, and keep print fallback only if it does not confuse the user.
- Exact pagination target is still product-sensitive. First target should be one page for normal small palettes around 7-10 colors; cap common cases at two pages if notes or palette size grows.

## 4. Verification Approach

Run from repo root after implementation:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run lint`

Manual verification on the Pages preview:

- Upload `docs/example_art/winding-path-9840681_640.jpg` or another test image.
- Merge down to about 7-10 colors.
- Enter artist notes in the textarea.
- Click `Download Maquette PDF`.
- Confirm the downloaded filename is based on the uploaded artwork and ends in `_maquette.pdf`.
- Confirm the PDF has no browser URL/date/page header or footer.
- Confirm swatches render in color.
- Confirm the PDF layout is art first, swatches/estimates right-aligned with empty workspace on the left, notes at the bottom, and total information at the bottom.
- Confirm common 7-10 color cases fit one page when practical and do not exceed two pages without a clear reason.
- After pushing, wait for `validate` and `deploy-preview` to pass and verify the preview URL loads.

## 5. Open Questions

- Should generated PDFs include one page only for small palettes, or allow page two for larger notes text?
- Should the PDF include vector grid lines over embedded images, or flatten the grid into raster image previews before embedding?
- Should the old browser `Print / Save PDF` button remain as a fallback, or be removed once generated PDF works?

