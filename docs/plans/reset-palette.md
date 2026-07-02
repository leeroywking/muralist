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

## Verification

- typecheck, `node --test` suite (55/57, 2 runtime-skips), static-export build — all green.
- Headless Chrome (Playwright cache) end-to-end on `viking_choir.jpg`:
  50 colors → Reset disabled → auto-combine 50→6 → Reset enabled →
  reset 6→50 → Reset disabled again. Confirm dialog copy verified.
