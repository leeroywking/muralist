# In-app confirm modal

Shipped to production 2026-10-12, via PR #17, merged as part of #13.

## Bug
Destructive actions used native `window.confirm()`. After a couple of dialogs, Chrome offers "Prevent this page from creating additional dialogs". Once that is ticked, `confirm()` silently returns `false`, so **Reset to original colors** and **Full reset** stopped working with no feedback.

## Fix
- `apps/web/app/ConfirmDialog.tsx` provides a `ConfirmDialog` built on native `<dialog>` + `showModal()`, plus a `useConfirm()` hook:
  `const { confirm, dialog } = useConfirm(); if (!(await confirm({ title, message, confirmLabel, cancelLabel, destructive }))) return;`
- Behavior:
  - Esc and backdrop clicks cancel.
  - On destructive actions, Cancel has focus by default.
  - Focus returns to the trigger button on close.
  - `aria-labelledby` and `aria-describedby` are wired up.
- The promise bookkeeping lives in `createConfirmController()`, which has no React or DOM, so `apps/web/app/confirmDialog.test.ts` tests it under `node:test`.
- Call sites, all migrated with unchanged messages:
  - `PrototypeApp.tsx`: Reset to original colors, Full reset;
  - `ProjectsDashboard.tsx`: delete project. Its `confirmFn` seam accepts `boolean | Promise<boolean>`.
- Layout: on screens 480px wide or narrower, the buttons stack full-width.

## Rule going forward
Don't use native `alert()`, `confirm()` or `prompt()` in the web app. Use `useConfirm()`.
