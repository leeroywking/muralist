# Site theme: dark/light toggle with teal accent

Shipped to production 2026-10-12, via PR #16, merged as part of #13.

## Goal
- Off-black/off-white site palette, loosely Adobe-like.
- Electric teal `#4CC9F0` accent: for outlines and highlighted text on dark surfaces. Wherever it touches a light surface, it must be outlined.
- Dark and light are both first-class, with a user toggle.

## Theme resolution (user rule: always respect the visitor's preference)
1. The visitor's saved toggle choice (`localStorage["muralist-theme"]`).
2. Otherwise the OS/browser `prefers-color-scheme`.
3. Dark, only when neither is available (matchMedia missing).

The user first asked for "dark by default", then corrected it to follow the visitor's preset. Product defaults never override a preference the visitor already expressed.

## Mechanism
- `data-theme` on `<html>`, set before first paint by the inline script `apps/web/app/themeScript.ts` (inlined by `layout.tsx`). There is no flash, and it works in the static export.
- Until the visitor uses the toggle, OS changes are followed live. All storage and matchMedia access is wrapped in try/catch.
- `apps/web/app/ThemeToggle.tsx` is a `role="switch"` button in the header nav, showing a moon or sun glyph chosen by CSS.
- Tokens live in `apps/web/app/styles.css`:
  - dark under `:root, :root[data-theme="dark"]`, light under `:root[data-theme="light"]`;
  - components use semantic accent tokens (`--accent-text`, `--pill-active-*`, `--badge-*`, ...).
- Print output and the paper field sheet stay light in both themes.

## Teal usage
Teal is one hue with its tone adjusted per surface (Material 3 tonal practice), so it meets WCAG 1.4.3 for text (4.5:1) and 1.4.11 for non-text elements (3:1).
- **Dark:** bright `#4CC9F0` is used directly for links, headings, outlines, focus rings and the MIX badge. Contrast is 8.2:1 or better on every dark surface.
- **Light:**
  - Deep teal `#0A6E8A` is used for text, lines and focus rings (4.78:1 or better).
  - Bright `#4CC9F0` is only a fill with an off-black `#161616` edge and text (9.41:1): the MIX badge, the active preset pill and the header rule.
  - Bright teal on the light page is 1.71:1, so it is never used as text or a line there.

Unchanged: artwork swatches, mural previews, `maquettePdf.ts` and the sign-in provider brand colors.
