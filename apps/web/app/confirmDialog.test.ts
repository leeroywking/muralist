// Unit tests for `ConfirmDialog.tsx`, the in-app replacement for
// `window.confirm()`. Covers the promise controller (no DOM needed) and a
// static-markup render of the dialog's accessible structure. Live behavior
// (showModal, Esc, backdrop, focus) is exercised in a real browser.

import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ConfirmDialog,
  createConfirmController,
  type ConfirmOptions
} from "./ConfirmDialog.js";

const OPTIONS: ConfirmOptions = {
  title: "Full reset?",
  message: "This discards every merge.",
  confirmLabel: "Full reset",
  destructive: true
};

test("controller resolves true only on an explicit confirm", async () => {
  const seen: Array<ConfirmOptions | null> = [];
  const controller = createConfirmController((o) => seen.push(o));
  const pending = controller.request(OPTIONS);
  assert.deepEqual(seen, [OPTIONS]);
  controller.settle(true);
  assert.equal(await pending, true);
  assert.deepEqual(seen, [OPTIONS, null]);
});

test("controller resolves false on cancel", async () => {
  const controller = createConfirmController(() => {});
  const pending = controller.request(OPTIONS);
  controller.settle(false);
  assert.equal(await pending, false);
});

test("controller keeps working across many requests", async () => {
  const controller = createConfirmController(() => {});
  for (let i = 0; i < 6; i += 1) {
    const pending = controller.request(OPTIONS);
    controller.settle(i % 2 === 0);
    assert.equal(await pending, i % 2 === 0);
  }
});

test("a newer request cancels an unanswered one", async () => {
  const controller = createConfirmController(() => {});
  const first = controller.request(OPTIONS);
  const second = controller.request({ ...OPTIONS, title: "Second" });
  assert.equal(await first, false);
  controller.settle(true);
  assert.equal(await second, true);
});

test("settle with nothing pending is a no-op", () => {
  const seen: Array<ConfirmOptions | null> = [];
  const controller = createConfirmController((o) => seen.push(o));
  controller.settle(true);
  assert.deepEqual(seen, [null]);
});

test("ConfirmDialog renders an accessible labelled <dialog>", () => {
  const markup = renderToStaticMarkup(
    createElement(ConfirmDialog, {
      ...OPTIONS,
      onConfirm: () => {},
      onCancel: () => {}
    })
  );
  assert.match(markup, /^<dialog /);
  assert.match(markup, /class="confirm-dialog is-destructive"/);
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
  const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
  assert.ok(labelledBy && markup.includes(`id="${labelledBy}"`));
  assert.ok(describedBy && markup.includes(`id="${describedBy}"`));
  assert.match(markup, />Full reset\?</);
  assert.match(markup, />This discards every merge\.</);
  assert.match(markup, />Cancel</);
  assert.match(markup, />Full reset</);
});
