# Title rename, SVG uploads, Benjamin Moore brand

Three small independent changes, batched on one branch.

## 1. Title → "Muraliste"

User-facing brand string renamed `Muralist` → `Muraliste` (matches the
`muraliste.com` domain) in `layout.tsx` (title + header), `PrototypeApp.tsx`
(h1 + account tooltip), `about/page.tsx`, `signin/page.tsx`, `projects/page.tsx`,
`SignInButtons.tsx`, and the `maquettePdf.ts` field-sheet heading. Package names
(`@muralist/*`), the repo, and internal code comments are unchanged (not
user-facing).

## 2. SVG uploads

`sanitizeUpload` (`apps/web/app/uploadPipeline.ts`) now accepts `.svg`:
- `.svg` added to `ALLOWED_EXTENSIONS`; `verifyMagicBytes` detects SVG by its
  `<svg>` root tag (returns a `DetectedImageKind` of `"raster"` | `"svg"`).
- SVG decode path `rasterizeSvgToBitmap`: loads the file as an isolated `<img>`
  (secure-static mode — no scripts, no external subresource loads, canvas not
  tainted), draws it onto a canvas scaled so the long edge ≈ `sanitizedImage.longEdge`
  for a crisp raster, white-mattes for JPEG (no alpha), then feeds the same JPEG
  encoder as the raster path.

**AGENTS "bypass upload validation" flag — addressed, not bypassed:** SVG is
never executed or stored as SVG. Output is raster JPEG (payload neutralized); the
server `contentTypeAllowlist` stays `jpeg`/`webp` (the backend never sees SVG);
the file is loaded only as an `<img>` src, never injected as markup.

File input already uses `accept="image/*"`, so no input change needed.

## 3. Benjamin Moore brand

Added `benjamin_moore` to `config/paint-brands.yaml` (Regal Select Interior:
coverage 400/425/450, USD prices, four finishes — Flat/Eggshell/Pearl/Semi-Gloss).
Passes config validation. Updated the two `brands.length === 3` assertions to `4`
(`packages/config/test/index.test.ts`, `apps/api/test/server.test.ts`).

## Verification

- typecheck / test / build / lint — all green (added SVG magic-byte + branch
  tests; Benjamin Moore validated by the config suite).
- Headless Chrome: title reads Muraliste (title/header/h1); Benjamin Moore in the
  brand dropdown; test SVG upload produced a 22-color palette with its red/blue/
  yellow all present (confirms the rasterize path end-to-end).
