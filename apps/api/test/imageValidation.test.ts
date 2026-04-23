import test from "node:test";
import assert from "node:assert/strict";
import {
  validateImagePayload,
  validateContentType
} from "../src/imageValidation.js";
import type { UploadLimits } from "@muralist/config";

const limits: UploadLimits = {
  version: 1,
  sanitizedImage: { maxBytes: 25600, longEdge: 640, jpegQuality: 0.8 },
  thumbnail: { maxBytes: 8192, longEdge: 192, jpegQuality: 0.8 },
  contentTypeAllowlist: ["image/jpeg", "image/webp"]
};

function jpegBytes(extra = 0): Buffer {
  // Minimum valid-looking JPEG: SOI + APP0 marker + padding.
  const header = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, // SOI + APP0
    0x00, 0x10, // APP0 length
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00 // version + density
  ]);
  const trailing = Buffer.alloc(extra, 0x00);
  return Buffer.concat([header, trailing]);
}

function webpBytes(extra = 0): Buffer {
  const header = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x20, 0x00, 0x00, 0x00, // file size (dummy)
    0x57, 0x45, 0x42, 0x50, // WEBP
    0x56, 0x50, 0x38, 0x20 // VP8 chunk id
  ]);
  const trailing = Buffer.alloc(extra, 0x00);
  return Buffer.concat([header, trailing]);
}

test("accepts a minimal JPEG payload under the sanitized cap", () => {
  const b64 = jpegBytes(100).toString("base64");
  const result = validateImagePayload(b64, "sanitizedImage", limits);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.bytes[0], 0xff);
    assert.equal(result.bytes[1], 0xd8);
  }
});

test("accepts a minimal WebP payload under the thumbnail cap", () => {
  const b64 = webpBytes(100).toString("base64");
  const result = validateImagePayload(b64, "thumbnail", limits);
  assert.equal(result.ok, true);
});

test("rejects empty string as INVALID_BASE64", () => {
  const result = validateImagePayload("", "sanitizedImage", limits);
  assert.deepEqual(result, { ok: false, reason: "INVALID_BASE64" });
});

test("rejects non-base64 characters as INVALID_BASE64", () => {
  const result = validateImagePayload("not*valid$base64!", "sanitizedImage", limits);
  assert.deepEqual(result, { ok: false, reason: "INVALID_BASE64" });
});

test("rejects payload over cap as OVER_SIZE (sanitized)", () => {
  const oversized = jpegBytes(limits.sanitizedImage.maxBytes + 500);
  const b64 = oversized.toString("base64");
  const result = validateImagePayload(b64, "sanitizedImage", limits);
  assert.deepEqual(result, { ok: false, reason: "OVER_SIZE" });
});

test("rejects payload over thumbnail cap as OVER_SIZE", () => {
  const oversized = jpegBytes(limits.thumbnail.maxBytes + 100);
  const b64 = oversized.toString("base64");
  const result = validateImagePayload(b64, "thumbnail", limits);
  assert.deepEqual(result, { ok: false, reason: "OVER_SIZE" });
});

test("rejects payload with truncated magic bytes as BAD_MAGIC_BYTES", () => {
  const tiny = Buffer.from([0xff, 0xd8]); // only 2 bytes
  const b64 = tiny.toString("base64");
  const result = validateImagePayload(b64, "sanitizedImage", limits);
  assert.deepEqual(result, { ok: false, reason: "BAD_MAGIC_BYTES" });
});

test("fast-fails base64 under 16 chars as BAD_MAGIC_BYTES", () => {
  // 12 chars decodes to at most 9 bytes — can't be a real image.
  const result = validateImagePayload("aGVsbG93b3Js", "sanitizedImage", limits);
  assert.deepEqual(result, { ok: false, reason: "BAD_MAGIC_BYTES" });
});

test("rejects PNG-like payload as BAD_MAGIC_BYTES (no match for JPEG or WebP)", () => {
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x00, 0x00, 0x00, 0x00
  ]);
  const b64 = png.toString("base64");
  const result = validateImagePayload(b64, "sanitizedImage", limits);
  assert.deepEqual(result, { ok: false, reason: "BAD_MAGIC_BYTES" });
});

test("rejects RIFF header without WEBP tag as BAD_MAGIC_BYTES", () => {
  // RIFF ... AVI (not WEBP)
  const avi = Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x41, 0x56, 0x49, 0x20]),
    Buffer.alloc(8, 0x00)
  ]);
  const b64 = avi.toString("base64");
  const result = validateImagePayload(b64, "sanitizedImage", limits);
  assert.deepEqual(result, { ok: false, reason: "BAD_MAGIC_BYTES" });
});

test("rejects format absent from the allowlist even if magic matches", () => {
  // Build a limits object where image/jpeg is NOT allowed.
  const restricted: UploadLimits = {
    ...limits,
    contentTypeAllowlist: ["image/webp"]
  };
  const b64 = jpegBytes(50).toString("base64");
  const result = validateImagePayload(b64, "sanitizedImage", restricted);
  assert.deepEqual(result, { ok: false, reason: "UNSUPPORTED_TYPE" });
});

test("rejects base64 with stripped padding that does not round-trip", () => {
  // Use a payload that is (a) >= 16 chars so it clears the tiny-payload
  // fast-fail, (b) legal per the character regex, and (c) fails the
  // re-encode round-trip because its length % 4 !== 0 after a single
  // trailing non-base64 byte's-worth of misalignment.
  const invalid = "AAAAAAAAAAAAAAAAA"; // 17 chars, length %4 === 1
  const result = validateImagePayload(invalid, "sanitizedImage", limits);
  assert.deepEqual(result, { ok: false, reason: "INVALID_BASE64" });
});

test("validateContentType accepts image/jpeg", () => {
  assert.deepEqual(validateContentType("image/jpeg", limits), { ok: true });
});

test("validateContentType accepts image/jpeg with charset param", () => {
  assert.deepEqual(validateContentType("image/jpeg; charset=utf-8", limits), {
    ok: true
  });
});

test("validateContentType rejects image/png", () => {
  assert.deepEqual(validateContentType("image/png", limits), {
    ok: false,
    reason: "UNSUPPORTED_TYPE"
  });
});

test("validateContentType rejects missing header", () => {
  assert.deepEqual(validateContentType(undefined, limits), {
    ok: false,
    reason: "UNSUPPORTED_TYPE"
  });
});

test("validateContentType is case-insensitive", () => {
  assert.deepEqual(validateContentType("IMAGE/JPEG", limits), { ok: true });
});
