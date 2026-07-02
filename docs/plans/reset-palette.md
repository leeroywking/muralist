# Reset palette to original colors

## Goal

A one-click **"Reset to original colors"** button that returns the palette to the
image as uploaded — nothing merged. The inverse of Auto-combine / manual merge.

## Baseline

`handleFileChange` stores the raw analyzer output in `sourceAnalysis` (set only on
upload) and seeds `paletteColors = result.colors`. That snapshot is the "nothing
merged" baseline. Both merge paths (`mergeSelectedColors`, `handleAutoCombine`)
only ever *shrink* the color set and keep existing ids, so `sourceAnalysis.colors`
is a superset — restoring it cleanly reintroduces every original color.

## Behavior — "full clean slate"

On confirm, `handleResetPalette`:
- `paletteColors ← sourceAnalysis.colors`
- clears `classifications`, `mixRecipes`
- clears merge selection (`selectedColorIds`, `mergeKeeperId`)
- clears per-color `colorFinishOverrides`, `colorCoatsOverrides`
- forgets the on-device merge plan: `setSavedMergePlan(null)` + removes
  `savedMergePlanKey` from localStorage (guest-only path; no-op when signed in)

Guardrails:
- `window.confirm` before wiping, since it discards work.
- `canResetPalette` predicate disables the button when there's nothing to undo
  (palette matches the survey and no derived/override/plan state exists).

Placement: merge toolbar, immediately after "Auto-combine similar colors"
(its logical inverse), with a muted neutral `.reset-button` style.

## Full reset — re-derive from the image (added after review)

`handleResetPalette` restores whatever palette was *captured* into `sourceAnalysis`.
That's the raw analysis for a fresh upload, but for a **loaded cloud project** the
hydrate path sets `sourceAnalysis = { width, height, colors: [] }` (it does not
re-cluster — the backend palette is authoritative). So "Reset to original colors"
there is effectively "reset to saved," not the true beginning.

`handleFullReset` closes that gap: it re-runs the analyzer on `sourcePixelsRef`
(a stable snapshot of the original image pixels, captured once at upload/load) via
a new module-level `analyzePixels(data, width, height)` — extracted from
`analyzeLoadedImage`, which now delegates to it. Result: the palette is rebuilt
from the picture itself, discarding every merge/edit/saved baseline. Art + wall
settings stay. Enabled whenever an image is loaded (`paletteColors.length > 0`);
guarded by a confirm. Distinct red-tinted `.full-reset-button` vs. the muted
grey un-merge reset.

Both buttons live side by side in the merge toolbar. They produce the same result
for a fresh upload; they differ for a loaded project (captured/saved vs. re-derived).

## Verification

- typecheck, `node --test` suite (55/57, 2 runtime-skips), static-export build — all green.
- Headless Chrome (Playwright cache) end-to-end on `viking_choir.jpg`:
  50 colors → Reset disabled → auto-combine 50→6 → Reset enabled →
  reset 6→50 → Reset disabled again → Full reset enabled →
  auto-combine 50→6 → **Full reset re-derived 50** → un-merge Reset disabled.
  Both confirm dialogs verified.
