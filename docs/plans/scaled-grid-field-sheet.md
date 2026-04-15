# Scaled Grid Field Sheet Plan

Task summary: Implement the scaled-grid field-sheet workflow described in `docs/scaled-grid-product-spec.md`, keeping web preview and print/PDF output unified.

## 1. Step-By-Step Plan

1. Add pure field-sheet math in `packages/core/src/index.ts`.
   - Add types for wall dimensions, grid specification, aspect-ratio report, and field-sheet color totals.
   - Add a function to derive wall area, grid rows/columns, cell area, and partial-edge metadata from wall dimensions and grid cell size.
   - Add a function to compare source image aspect ratio against entered wall aspect ratio and return `shouldWarn`.
   - Add a function to derive per-color square footage from `coveragePercent`.
   - Keep this logic pure: no DOM, no canvas, no file, no network.

2. Add tests in `packages/core/test/index.test.ts`.
   - Test valid grid derivation for standard wall sizes.
   - Test invalid wall dimensions and invalid grid cell sizes.
   - Test ratio mismatch detection for `4:3` source artwork against a `16:4` wall.
   - Test close-ratio inputs that should not warn.
   - Test per-color square-foot derivation from coverage percentages.

3. Update the web state and controls in `apps/web/app/PrototypeApp.tsx`.
   - Add grid cell size state with first-version options: `1`, `2`, and `4` feet.
   - Keep existing wall dimension inputs, but consider label clarification to `Wall width (ft)` and `Wall height (ft)` if the UI change remains scoped.
   - Build one serializable field-sheet model from existing source analysis, palette colors, selected brand, wall dimensions, grid settings, and `suggestContainersForColors`.
   - Preserve the existing upload and palette merge behavior.

4. Extract or add a field-sheet render component in `apps/web/app/PrototypeApp.tsx`.
   - Render from the single field-sheet model.
   - Include the original artwork view with source aspect ratio preserved.
   - Include the reduced-color mural preview fit to the entered wall aspect ratio.
   - Show a visible ratio warning when the core ratio report says to warn.
   - Keep artist notes/mixing workspace on the left, visual previews in the main area, and structured data on the right.
   - Include large paint-over swatches for each palette entry.

5. Add grid overlay rendering in `apps/web/app/PrototypeApp.tsx` and `apps/web/app/styles.css`.
   - Wrap each preview image in a positioned grid container.
   - Use CSS layered over the image for grid lines.
   - Original artwork container uses source aspect ratio.
   - Reduced mural preview container uses wall aspect ratio.
   - Reduced mural preview grid represents consistent real-world square spacing.
   - Labels must distinguish `Original artwork` from `Reduced mural preview`.

6. Evolve the existing print summary in `apps/web/app/PrototypeApp.tsx`.
   - Replace or extend the current `.print-summary` section so the same field-sheet component is used for screen preview and print.
   - Keep the existing `window.print()` flow for first implementation.
   - Do not duplicate calculations separately for print.

7. Update print and screen styles in `apps/web/app/styles.css`.
   - Make the screen field-sheet preview visually close to the printed maquette/PDF.
   - Target US Letter landscape for first print version.
   - Keep left-side notes area mostly empty.
   - Make right-side swatch targets at least `1.25in` by `1.25in` in print.
   - Use print CSS only for page margins, sizing, pagination, and hiding app chrome.

8. Update the PR description and manual review plan when implementing.
   - Reference `docs/scaled-grid-product-spec.md`.
   - Include a manual test case using a mismatched ratio, such as `4:3` source and `16:4` wall.
   - Include screen preview and print/PDF checks.

## 2. AGENTS.md Flag Check

- Guest-mode persistent write boundary: does not apply if this stays browser-local with no saved project or server persistence. If implementation adds any persistent save path, stop and enforce `session.kind === "user"` before writing.
- CORS widening: does not apply. Do not modify `apps/api/src/server.ts` CORS settings as part of this feature.
- OAuth provider tokens: does not apply.
- Committed user-scoped data: does not apply. Do not commit generated user artwork, final mixes, or per-user brand overrides.
- DynamoDB-first modeling: does not apply unless persistence is added. If persistence is added later, avoid relational-join assumptions in any saved field-sheet model.
- New public endpoint: not planned. If a new endpoint is introduced, stop and add input validation and rate limiting.
- Upload validation: current browser upload validation remains relevant. Do not bypass file type or size validation. If upload moves server-side, add file type, size, and image decoding validation before accepting files.

## 3. Ambiguity Check

Ambiguity check:

- Grid edge behavior is still open: when wall dimensions do not divide evenly by the selected grid cell size, the implementation can either show partial edge cells or constrain choices to evenly dividing grid sizes. Build partial-edge labeling first because it supports more real wall dimensions and does not hide measurement reality.
- Component extraction depth is flexible: the field sheet can remain in `apps/web/app/PrototypeApp.tsx` for a first pass or be extracted into a web-local component. Build whichever keeps the first implementation clearest, but keep one shared field-sheet model and avoid duplicate web/print calculations.

## 4. Verification Approach

Run from repo root after implementation:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run lint`

Manual verification:

- Upload an image and confirm the original artwork view preserves source aspect ratio.
- Confirm the reduced mural preview uses entered wall aspect ratio.
- Enter a `4:3`-like source and `16:4` wall dimensions and confirm the ratio warning appears.
- Confirm both views have grid overlays.
- Confirm palette rows show square footage, quantity/package recommendations, and large paint-over swatches.
- Use `Print / Save PDF` and confirm the printed/PDF sheet matches the web preview content and layout expectations.
- If UI changes are included in a PR, wait for CI and the Pages preview, then confirm the preview URL loads the new behavior before reporting done.

## 5. Open Questions

- Should first implementation show partial edge cells explicitly, or should it steer users toward grid sizes that divide the wall evenly?
- Should the first printable sheet be strictly one-page US Letter landscape, or allow overflow to additional pages when palette count is high?
- Should source dimension labels use `Wall width` and `Wall height` immediately, or leave the existing `Length` and `Width` labels until a broader UI copy pass?
- Should per-cell color area be deferred fully, or should the first implementation calculate cell-level color shares for the reduced image while still reporting global totals?

