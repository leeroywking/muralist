# Scaled Grid Field Sheet Product Spec

This spec turns the exploratory notes in `docs/scaled-grid-estimation-notes.md` into build guidance for a future implementation. The original notes remain useful product context; this file is the directive spec for code work.

## Goal

Add a scaled-grid field-sheet workflow to Muralist so an artist can:

1. Upload artwork.
2. Enter real mural dimensions.
3. Review whether the artwork ratio matches the wall ratio.
4. See the original artwork and the reduced-color mural plan with scaled grid overlays.
5. Get per-color area and paint quantity estimates.
6. Print or save a maquette/PDF-style field sheet that matches the web preview.
7. Use the printed sheet for manual paint mixing, notes, and hardware-store color matching.

The feature should support the artist's judgment. Muralist estimates scale, area, and quantity; the artist remains free to mix, adjust, paint over swatches, and choose final colors.

## Existing Surfaces

Start with the current prototype surfaces:

- `apps/web/app/PrototypeApp.tsx` handles upload, browser-side image analysis, palette merging, paint estimates, and print summary rendering.
- `apps/web/app/styles.css` already has `.print-summary` and `@media print` rules. Treat this as the beginning of the maquette/PDF surface, not a separate downstream output.
- `packages/core/src/index.ts` owns pure estimation logic such as `suggestContainersForColors`. New grid geometry, area math, and printable-sheet data shaping should prefer pure functions here when they do not require browser APIs.
- `apps/api/src/server.ts` currently exposes paint-brand and estimate endpoints. Do not add persistence or new public endpoints for this feature unless a separate plan handles validation and rate limiting.
- `config/paint-brands.yaml` remains the source of global brand coverage assumptions through `@muralist/config`.

## Primary User Flow

### 1. Upload Artwork

The user uploads an image as they do today. The web app captures:

- original preview URL
- analyzed source dimensions
- dominant or reduced palette colors
- reduced-color image data

Keep the original artwork visible throughout the workflow. The original is not just an upload confirmation; it is one of the required field-sheet outputs.

### 2. Enter Wall Dimensions

The user enters mural dimensions in feet:

- width or length
- height
- optional grid cell size

The current prototype labels these fields as `Length (ft)` and `Width (ft)`. A future UI can rename them to `Wall width (ft)` and `Wall height (ft)` if that reduces ambiguity, but any code change should preserve existing estimate behavior until the full UI change is planned.

Derived values:

- `wallAreaSqFt = wallWidthFt * wallHeightFt`
- `wallAspectRatio = wallWidthFt / wallHeightFt`
- `sourceAspectRatio = sourceWidthPx / sourceHeightPx`
- `aspectRatioDelta = wallAspectRatio / sourceAspectRatio`

### 3. Choose Grid Scale

The user should be able to choose a grid scale. First version options:

- default cell size: 2 ft by 2 ft
- alternate cell sizes: 1 ft, 4 ft
- optional custom cell size later

Derived values:

- `cellWidthFt = cellSizeFt`
- `cellHeightFt = cellSizeFt`
- `columns = ceil(wallWidthFt / cellWidthFt)`
- `rows = ceil(wallHeightFt / cellHeightFt)`
- `cellAreaSqFt = cellWidthFt * cellHeightFt`

If the wall dimensions do not divide evenly by the chosen cell size, the final row or final column may represent a partial physical cell. The UI should either label this or choose a grid size that divides the wall exactly. Do not silently imply every edge cell is full size when it is not.

## Required Views

The web preview and the maquette/PDF output must include the same core views.

### Original Artwork View

Purpose: preserve the uploaded artwork as the artist supplied it.

Behavior:

- Do not stretch the image to the wall ratio.
- Do not crop the image to the wall ratio.
- Preserve the original artwork aspect ratio.
- Overlay a grid that maps the wall grid onto the source image bounds.
- The printed spacing between vertical and horizontal grid lines may differ in this view when the source ratio differs from the wall ratio.

This view answers: "What did I upload, and how does the wall grid relate to that source?"

### Reduced Mural Output View

Purpose: show the paintable mural plan as it will map to the entered wall dimensions.

Behavior:

- Use the reduced-color artwork, not the original full-color artwork.
- Fit the reduced-color artwork into the user-entered wall aspect ratio.
- If the source ratio and wall ratio differ, visibly distort this reduced-color view to the wall ratio.
- Overlay real-world square grid cells with consistent x and y physical spacing.
- Grid lines in this view represent the selected cell size in wall feet.

This view answers: "What will this plan look like on the wall dimensions I entered?"

### Ratio Mismatch Warning

If the source artwork and wall dimensions do not match closely, show a visible warning near the two views.

Initial threshold:

- warn when `abs(log(wallAspectRatio / sourceAspectRatio)) > 0.05`

The exact threshold can change, but it should catch clear cases such as `4:3` source artwork with a `16:4` wall.

Warning copy should be direct and non-alarming:

```text
Your wall ratio differs from the uploaded artwork. The mural preview is stretched to the wall size so you can catch the mismatch before painting.
```

## Example Behavior

Given:

- source artwork ratio: `4:3`
- wall ratio: `16:4`

Expected output:

- Original artwork view remains `4:3`.
- Original artwork grid is adjusted to the source image bounds, so the apparent printed spacing can differ between x and y.
- Reduced mural output view becomes very wide because it is fit to `16:4`.
- Reduced mural output grid uses consistent real-world square spacing.
- The user can immediately see that the entered wall shape and uploaded artwork shape do not line up.

## Field Sheet Layout

The printable maquette/PDF field sheet should be designed as a working studio and job-site sheet, not just a report.

Recommended layout:

- Left side: artist note and mixing workspace.
- Main visual area: original artwork view and reduced mural output view.
- Right side: structured Muralist data.

### Left Side: Artist Workspace

Reserve blank or lightly ruled space for:

- hand-written mixing ratios
- substitutions
- brand or store notes
- coat notes
- on-site observations
- final artist decisions

Do not fill this area with generated text. Its value is that the artist can write on it.

### Main Visual Area

Include:

- original artwork with adjusted grid overlay
- reduced-color mural output with wall-ratio grid overlay
- clear labels explaining which view preserves the upload and which view previews the wall
- wall dimensions and grid scale

The grid should be visible but not overpower the artwork. Use consistent visual treatment between screen and print.

### Right Side: Structured Data

Keep calculated data on the right side:

- palette color swatch
- color id or label
- generated color value, such as hex
- estimated coverage percent
- estimated square footage for that color
- finish
- coats
- required paint volume
- recommended package plan from `suggestContainersForColors`
- estimated price, if available

This data should remain useful even when the artist changes the final mixed color.

## Paint-Over Swatches

Each palette entry must include a large swatch target.

Purpose:

- show Muralist's current reduced color
- tell the artist where that color maps in the mural plan
- give the artist a physical area to paint over with their preferred final mix
- support hardware-store scanning or matching after the artist paints over the swatch

Implementation requirements:

- The printable swatch should be much larger than the existing `.print-swatch` chip in `apps/web/app/styles.css`.
- Minimum first-version print size: 1.25 in by 1.25 in.
- Leave whitespace around the swatch for drying, labeling, and scanner placement.
- Do not put essential text inside the swatch area, because the artist may paint over it.
- Keep generated hex or label adjacent to the swatch, not embedded in it.

## Area And Quantity Math

For first implementation, use palette coverage percentages to calculate area:

```text
colorAreaSqFt = wallAreaSqFt * (coveragePercent / 100)
```

Then pass that coverage into existing package planning logic through `suggestContainersForColors` in `packages/core/src/index.ts`.

The spec should eventually move toward cell-aware area tallies:

```text
cellColorAreaSqFt = cellAreaSqFt * colorPixelShareWithinCell
colorAreaSqFt = sum(cellColorAreaSqFt for all cells)
```

First version can use global color coverage percentages if implementing per-cell pixel shares is too large for one change. If first version does not calculate per-cell area, the UI should not imply that every cell has been individually analyzed.

## Suggested Data Types

Prefer pure data structures that can drive both web and print rendering.

Candidate types for `packages/core/src/index.ts` or a web-local module before extraction:

```ts
type WallDimensions = {
  widthFt: number;
  heightFt: number;
};

type GridSpec = {
  cellSizeFt: number;
  columns: number;
  rows: number;
  cellAreaSqFt: number;
};

type AspectRatioReport = {
  sourceAspectRatio: number;
  wallAspectRatio: number;
  ratioDelta: number;
  shouldWarn: boolean;
};

type FieldSheetColor = {
  colorId: string;
  hex: string;
  coveragePercent: number;
  areaSqFt: number;
  finishId: string;
  coats: number;
  requiredGallons: number;
  packageLabel: string;
  estimatedCost: number;
};

type FieldSheetModel = {
  fileName: string;
  sourceSize: { widthPx: number; heightPx: number };
  wall: WallDimensions;
  grid: GridSpec;
  aspectRatio: AspectRatioReport;
  colors: FieldSheetColor[];
  totals: {
    areaSqFt: number;
    packageLabel: string;
    requiredGallons: number;
    estimatedCost: number;
    currency: string;
  };
};
```

Keep this model serializable. It should not contain DOM nodes, canvas contexts, object URLs, or browser-only classes.

## Web And PDF Unity

The artist should not be surprised by a different output format when they print or save a PDF. The screen preview and maquette/PDF should be the same product surface in two layouts, not two separate products.

Implementation requirements:

- Build one field-sheet model and render both the screen preview and print view from it.
- Prefer one React component for the field sheet, with CSS handling screen vs print differences.
- Avoid duplicating table rows or calculations separately for web and print.
- Keep labels, ordering, swatch sizes, quantities, and ratio warnings consistent.
- Any control-only UI can be hidden for print, but the field sheet content should not change meaning.
- Use print CSS only for pagination, sizing, margins, and hiding non-sheet chrome.

Current hook point:

- Replace or evolve the existing `.print-summary` section in `apps/web/app/PrototypeApp.tsx`.
- Keep the current `window.print()` flow for first version.
- Update `apps/web/app/styles.css` so the screen preview resembles the printable sheet closely.

Acceptance rule:

- If a user reviews the field sheet on the web page, then clicks `Print / Save PDF`, the PDF should feel like the same sheet with print margins applied.

## Implementation Guidance

### Keep Core Pure

Any math that does not need browser APIs should live in `packages/core/src/index.ts` or a new pure module in `packages/core/src/`. Examples:

- grid derivation from wall dimensions and cell size
- aspect-ratio report
- color area derivation
- field-sheet color totals

Do not add I/O, filesystem access, network access, DOM access, or canvas access to `packages/core`.

### Keep Browser Rendering In Web

Browser-specific work should remain in `apps/web/app/PrototypeApp.tsx` or extracted web components:

- uploaded file object URLs
- canvas image flattening
- image rendering
- print button behavior
- CSS grid overlays

### Grid Overlay Rendering

A first implementation can render grid lines with CSS layered over an image:

- wrap each image in a positioned container
- render the image with `object-fit`
- overlay a grid layer using `repeating-linear-gradient`
- use CSS custom properties for columns, rows, and line color

For the reduced mural output view, the image container should use the wall aspect ratio. For the original artwork view, the container should use the source image aspect ratio.

Be explicit in naming:

- `Original artwork`
- `Reduced mural preview`
- `Wall-ratio preview`
- `Grid: 2 ft cells`

### Ratio Handling

Do not auto-correct the user's dimensions or silently letterbox the reduced mural output. The point is to reveal mismatch.

Required behavior:

- original view preserves source ratio
- reduced view fits wall ratio
- warning appears when ratios differ enough
- labels explain why one view may look stretched

### Print Sizing

The field sheet should be usable on standard paper.

First version target:

- US Letter landscape
- print margins handled through `@page`
- right-side data column wide enough for large paint-over swatches
- left-side notes area left mostly empty

Later version may support tabloid or multi-page exports, but that is not required for the first code pass.

## Non-Goals For First Implementation

- No project persistence.
- No user-scoped saved field sheets.
- No new API write path.
- No hardware-store scanner integration.
- No automatic store color matching.
- No doodle-grid wall photo alignment.
- No perspective correction.
- No irregular wall masks.
- No guarantee that printed colors are color accurate.

## Security And Boundary Notes

This feature can be implemented as a guest-safe, local, browser-driven workflow if it only uses uploaded image data in memory and print/PDF output generated by the browser.

Before adding any persistent save, upload, public endpoint, or server-side image processing, follow the `AGENTS.md` flag-before-implementing rules:

- persistent writes must enforce `session.kind === "user"`
- public endpoints need input validation and rate limiting
- uploads need file type, size, and image decoding validation
- do not widen CORS as part of this work

## Acceptance Criteria

The first implementation should satisfy:

- User can upload an image and see the original artwork view.
- User can see a reduced-color mural output view.
- User can enter wall dimensions and grid cell size.
- Both views show grid overlays.
- Original artwork view preserves source aspect ratio.
- Reduced mural output view uses entered wall aspect ratio.
- Clear warning appears when source and wall ratios differ.
- Palette table includes per-color area and paint quantity.
- Each palette entry includes a large paint-over swatch target.
- Artist note area appears on the left side of the field sheet.
- Calculated data appears on the right side of the field sheet.
- Web preview and print/PDF output use the same field-sheet model and content.
- `npm run typecheck`, `npm run test`, `npm run build`, and `npm run lint` pass before reporting the code work complete.

## Suggested Test Coverage

Add or update tests around pure functions in `packages/core/test/index.test.ts` if grid and ratio math moves into `packages/core`.

Test cases:

- derives wall area and square grid dimensions from wall size and cell size
- flags a clear ratio mismatch, such as `4:3` source and `16:4` wall
- does not flag a close ratio match
- computes per-color square footage from coverage percentages
- rejects or reports invalid wall dimensions and invalid cell sizes

For web rendering, use the existing app verification pattern for the repo. If adding component tests is not already wired, keep the first pass focused on core math tests plus manual preview/print verification in the PR test plan.

