import test from "node:test";
import assert from "node:assert/strict";
import {
  loadUploadLimits,
  validateUploadLimits,
  type UploadLimits
} from "../src/index.js";

test("upload limits load and validate", async () => {
  const limits = await loadUploadLimits();
  assert.equal(limits.version, 1);
  assert.ok(limits.sanitizedImage.maxBytes > 0);
  assert.ok(limits.thumbnail.maxBytes > 0);
  assert.ok(limits.sanitizedImage.maxBytes > limits.thumbnail.maxBytes);
});

test("content type allowlist is image/*", async () => {
  const limits = await loadUploadLimits();
  assert.ok(limits.contentTypeAllowlist.includes("image/jpeg"));
  assert.ok(limits.contentTypeAllowlist.includes("image/webp"));
  for (const type of limits.contentTypeAllowlist) {
    assert.ok(type.startsWith("image/"), `unexpected content type: ${type}`);
  }
});

test("validator rejects zero maxBytes on sanitized image", () => {
  const limits = buildFixture();
  limits.sanitizedImage.maxBytes = 0;
  assert.throws(() => validateUploadLimits(limits), /sanitizedImage\.maxBytes/);
});

test("validator rejects non-integer longEdge", () => {
  const limits = buildFixture();
  limits.thumbnail.longEdge = 192.5;
  assert.throws(() => validateUploadLimits(limits), /thumbnail\.longEdge/);
});

test("validator rejects jpegQuality outside (0, 1]", () => {
  const limits = buildFixture();
  limits.sanitizedImage.jpegQuality = 1.5;
  assert.throws(() => validateUploadLimits(limits), /sanitizedImage\.jpegQuality/);
});

test("validator rejects jpegQuality = 0", () => {
  const limits = buildFixture();
  limits.thumbnail.jpegQuality = 0;
  assert.throws(() => validateUploadLimits(limits), /thumbnail\.jpegQuality/);
});

test("validator rejects empty contentTypeAllowlist", () => {
  const limits = buildFixture();
  limits.contentTypeAllowlist = [];
  assert.throws(() => validateUploadLimits(limits), /contentTypeAllowlist/);
});

test("validator rejects non-image content types", () => {
  const limits = buildFixture();
  limits.contentTypeAllowlist = ["application/octet-stream"];
  assert.throws(() => validateUploadLimits(limits), /image\/\*/);
});

test("validator rejects missing sanitizedImage section", () => {
  const limits = buildFixture();
  (limits as unknown as { sanitizedImage: unknown }).sanitizedImage = undefined;
  assert.throws(() => validateUploadLimits(limits), /sanitizedImage/);
});

function buildFixture(): UploadLimits {
  return {
    version: 1,
    sanitizedImage: {
      maxBytes: 25600,
      longEdge: 640,
      jpegQuality: 0.8
    },
    thumbnail: {
      maxBytes: 8192,
      longEdge: 192,
      jpegQuality: 0.8
    },
    contentTypeAllowlist: ["image/jpeg", "image/webp"]
  };
}
