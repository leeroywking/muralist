// Unit tests for the non-canvas-dependent paths of `uploadPipeline.ts`.
// Canvas / OffscreenCanvas paths require a real browser and are deferred to
// the future UI round (per docs/plans/persistence-and-auth-backend.md §1
// step 29).

import test from "node:test";
import assert from "node:assert/strict";
// Node 18 exposes `File` via `node:buffer` (experimental); Node 20+ exposes
// it globally. Using the node:buffer import keeps the test portable.
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";

import {
  UploadSanitizationError,
  sanitizeUpload,
  verifyMagicBytes,
  blobToBase64
} from "./uploadPipeline.js";
import type { UploadLimits } from "@muralist/config";

const limits: UploadLimits = {
  version: 1,
  sanitizedImage: { maxBytes: 25600, longEdge: 640, jpegQuality: 0.8 },
  thumbnail: { maxBytes: 8192, longEdge: 192, jpegQuality: 0.8 },
  contentTypeAllowlist: ["image/jpeg", "image/webp"]
};

// Minimal JPEG magic prefix (SOI + APP0).
const JPEG_HEADER = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01
]);

// Minimal WebP magic prefix ("RIFF" ____ "WEBP").
const WEBP_HEADER = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20
]);

// PNG magic bytes — NOT on the pipeline allowlist.
const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x00,
  0x00, 0x00, 0x00
]);

function makeFile(bytes: Uint8Array, name: string, type: string): File {
  // Cast is safe: node:buffer's File extends Blob and matches the DOM File
  // shape for the surface area this module exercises (name, slice,
  // arrayBuffer).
  return new NodeFile([bytes], name, { type }) as unknown as File;
}

test("sanitizeUpload rejects non-allowlisted extensions", async () => {
  // .heic is not in the allowlist; .png is (see allowed-extensions test below).
  const file = makeFile(JPEG_HEADER, "photo.heic", "image/heic");
  await assert.rejects(
    () => sanitizeUpload(file, limits),
    (err: unknown) => {
      assert.ok(err instanceof UploadSanitizationError);
      assert.equal(
        (err as UploadSanitizationError).reason,
        "EXTENSION_NOT_ALLOWED"
      );
      return true;
    }
  );
});

test("sanitizeUpload accepts .png at the extension + magic-byte check", async () => {
  // PNG payload in .png file — passes both checks. The canvas decode step
  // isn't available in node:test, so we expect DECODE_FAILED or
  // OFFSCREEN_CANVAS_UNAVAILABLE (whichever the runtime surfaces first),
  // which confirms we've gotten past extension + magic-byte gates.
  const file = makeFile(PNG_HEADER, "photo.png", "image/png");
  await assert.rejects(
    () => sanitizeUpload(file, limits),
    (err: unknown) => {
      assert.ok(err instanceof UploadSanitizationError);
      const reason = (err as UploadSanitizationError).reason;
      return (
        reason === "DECODE_FAILED" || reason === "OFFSCREEN_CANVAS_UNAVAILABLE"
      );
    }
  );
});

test("sanitizeUpload rejects .gif even with JPEG magic bytes inside", async () => {
  const file = makeFile(JPEG_HEADER, "photo.gif", "image/gif");
  await assert.rejects(
    () => sanitizeUpload(file, limits),
    (err: unknown) =>
      err instanceof UploadSanitizationError &&
      err.reason === "EXTENSION_NOT_ALLOWED"
  );
});

test("sanitizeUpload accepts .JPG (case-insensitive) at the extension check", async () => {
  // Arbitrary non-image bytes in a .JPG file — extension passes (proving
  // case-insensitive match), magic-byte check fails. Using junk bytes rather
  // than PNG so we don't accidentally depend on PNG being rejected.
  const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
  const file = makeFile(junk, "photo.JPG", "image/jpeg");
  await assert.rejects(
    () => sanitizeUpload(file, limits),
    (err: unknown) =>
      err instanceof UploadSanitizationError &&
      err.reason === "MAGIC_BYTES_MISMATCH"
  );
});

test("sanitizeUpload rejects non-image binary data with an allowed extension", async () => {
  // Allowed extension + junk bytes — extension gate passes, magic-byte gate
  // fails. The three accepted formats (JPEG/WebP/PNG) are format-agnostic at
  // the magic-byte layer, so mixing them across extensions is tolerated;
  // only truly non-image data should trip MAGIC_BYTES_MISMATCH.
  const junk = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef]);
  const file = makeFile(junk, "fake.jpg", "image/jpeg");
  await assert.rejects(
    () => sanitizeUpload(file, limits),
    (err: unknown) => {
      assert.ok(err instanceof UploadSanitizationError);
      assert.equal(
        (err as UploadSanitizationError).reason,
        "MAGIC_BYTES_MISMATCH"
      );
      return true;
    }
  );
});

test("verifyMagicBytes accepts PNG", async () => {
  const blob = new NodeBlob([PNG_HEADER]) as unknown as Blob;
  await verifyMagicBytes(blob);
});

test("verifyMagicBytes accepts JPEG", async () => {
  const blob = new NodeBlob([JPEG_HEADER]) as unknown as Blob;
  await verifyMagicBytes(blob);
});

test("verifyMagicBytes accepts WebP", async () => {
  const blob = new NodeBlob([WEBP_HEADER]) as unknown as Blob;
  await verifyMagicBytes(blob);
});

test("verifyMagicBytes rejects RIFF without WEBP marker", async () => {
  // RIFF ____ AVI — valid RIFF container, wrong codec.
  const avi = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
    0x00, 0x00, 0x00, 0x00
  ]);
  const blob = new NodeBlob([avi]) as unknown as Blob;
  await assert.rejects(
    () => verifyMagicBytes(blob),
    (err: unknown) =>
      err instanceof UploadSanitizationError &&
      err.reason === "MAGIC_BYTES_MISMATCH"
  );
});

test("verifyMagicBytes rejects a truncated header (2 bytes)", async () => {
  const blob = new NodeBlob([new Uint8Array([0xff, 0xd8])]) as unknown as Blob;
  await assert.rejects(
    () => verifyMagicBytes(blob),
    (err: unknown) =>
      err instanceof UploadSanitizationError &&
      err.reason === "MAGIC_BYTES_MISMATCH"
  );
});

test("blobToBase64 round-trips through FileReader when available", async (t) => {
  // `FileReader` is not a Node built-in. Skip unless the runtime provides it
  // (jsdom, browser). The production consumer always runs in the browser.
  const hasFileReader =
    typeof (globalThis as { FileReader?: unknown }).FileReader === "function";
  if (!hasFileReader) {
    t.skip("FileReader not available in this runtime");
    return;
  }
  const blob = new NodeBlob([new Uint8Array([1, 2, 3, 4])]) as unknown as Blob;
  const base64 = await blobToBase64(blob);
  assert.equal(base64, Buffer.from([1, 2, 3, 4]).toString("base64"));
});
