"use client";

// In-app replacement for `window.confirm()`. Native dialogs are unreliable:
// after a couple of them Chrome offers "Prevent this page from creating
// additional dialogs", and once ticked `confirm()` silently returns false so
// every guarded action stops working. This builds on the native `<dialog>`
// element via `showModal()` (top layer, focus trapping, Esc, ::backdrop).
//
// Namespace import so the classic JSX transform used by the `tsx` test loader
// resolves `React.createElement` (see ProjectsDashboard.tsx).
import * as React from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get danger styling and focus Cancel by default. */
  destructive?: boolean;
};

// ---------------------------------------------------------------------------
// Controller — the promise bookkeeping, kept free of React/DOM so it can be
// unit-tested under node:test.
// ---------------------------------------------------------------------------

export type ConfirmController = {
  /** Open a request; resolves true only on an explicit confirm. */
  request(options: ConfirmOptions): Promise<boolean>;
  /** Settle the pending request (no-op when nothing is pending). */
  settle(result: boolean): void;
};

export function createConfirmController(
  onChange: (options: ConfirmOptions | null) => void
): ConfirmController {
  let pending: ((result: boolean) => void) | null = null;
  return {
    request(options) {
      // A newer request supersedes an unanswered one; the old one cancels.
      if (pending) pending(false);
      return new Promise<boolean>((resolve) => {
        pending = resolve;
        onChange(options);
      });
    },
    settle(result) {
      const resolve = pending;
      pending = null;
      onChange(null);
      if (resolve) resolve(result);
    }
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type ConfirmDialogProps = ConfirmOptions & {
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const messageId = `${baseId}-message`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnFocus =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) dialog.showModal();
    (destructive ? cancelRef.current : confirmRef.current)?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    };
    // Mount/unmount only: useConfirm keys the dialog per request.
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`confirm-dialog${destructive ? " is-destructive" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => {
        // Esc: keep React in charge of closing.
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        // The dialog box itself has no padding, so a click whose target is
        // the <dialog> element landed on the ::backdrop.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="confirm-dialog-body">
        <h2 id={titleId} className="confirm-dialog-title">
          {title}
        </h2>
        <p id={messageId} className="confirm-dialog-message">
          {message}
        </p>
        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog-button confirm-dialog-cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="confirm-dialog-button confirm-dialog-confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * `const { confirm, dialog } = useConfirm();` — render `{dialog}` somewhere in
 * the component tree, then `if (!(await confirm({...}))) return;`.
 */
export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactElement | null;
} {
  const [request, setRequest] = useState<{ id: number; options: ConfirmOptions } | null>(
    null
  );
  const controller = useMemo(() => {
    let nextId = 0;
    return createConfirmController((options) =>
      setRequest(options ? { id: ++nextId, options } : null)
    );
  }, []);
  const confirm = useCallback(
    (next: ConfirmOptions) => controller.request(next),
    [controller]
  );
  const dialog = request ? (
    <ConfirmDialog
      key={request.id}
      {...request.options}
      onConfirm={() => controller.settle(true)}
      onCancel={() => controller.settle(false)}
    />
  ) : null;
  return { confirm, dialog };
}
