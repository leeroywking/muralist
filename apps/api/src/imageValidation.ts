import type { UploadLimits } from "@muralist/config";

export type ImageKind = "sanitizedImage" | "thumbnail";

export type ImageErrorCode =
  | "INVALID_BASE64"
  | "OVER_SIZE"
  | "BAD_MAGIC_BYTES"
  | "UNSUPPORTED_TYPE";

export type ValidateImageResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: ImageErrorCode };

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

// JPEG: FF D8 FF (SOI marker + first APPn)
// WebP: RIFF (52 49 46 46), 4-byte size, WEBP (57 45 42 50)
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_RIFF = Buffer.from([0x52, 0x49, 0x46, 0x46]);
const WEBP_TAG = Buffer.from([0x57, 0x45, 0x42, 0x50]);

/**
 * Pure pass-through validation for base64-encoded image uploads.
 *
 * Does NOT decode the image through an image-parsing library. Every check
 * operates on raw bytes or the base64 string itself. This is a deliberate
 * pattern to keep image-parser CVEs (ImageMagick, Sharp, libvips) off the
 * request-path attack surface; the browser canvas re-encode is the primary
 * defense and the server's role is cheap corroboration.
 */
export function validateImagePayload(
  base64: string,
  kind: ImageKind,
  limits: UploadLimits
): ValidateImageResult {
  if (typeof base64 !== "string" || base64.length === 0) {
    return { ok: false, reason: "INVALID_BASE64" };
  }

  if (!BASE64_REGEX.test(base64)) {
    return { ok: false, reason: "INVALID_BASE64" };
  }

  // Proper base64 strings are padded to a multiple of 4 characters.
  if (base64.length % 4 !== 0) {
    return { ok: false, reason: "INVALID_BASE64" };
  }

  const cap = limits[kind].maxBytes;

  // Base64-string-length ceiling: decoded bytes = ceil(len * 3 / 4) minus padding.
  // If the raw string is already way past the cap, reject before decoding.
  const approxDecodedBytes = Math.floor((base64.length * 3) / 4);
  if (approxDecodedBytes > cap + 64) {
    return { ok: false, reason: "OVER_SIZE" };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, reason: "INVALID_BASE64" };
  }

  // Buffer.from with "base64" silently strips non-base64 characters rather
  // than throwing, so re-encode and compare to detect corruption that passed
  // the regex but wasn't valid base64 payload.
  const reEncoded = bytes.toString("base64").replace(/=+$/, "");
  const strippedInput = base64.replace(/=+$/, "");
  if (reEncoded !== strippedInput) {
    return { ok: false, reason: "INVALID_BASE64" };
  }

  if (bytes.length > cap) {
    return { ok: false, reason: "OVER_SIZE" };
  }

  if (bytes.length < 12) {
    return { ok: false, reason: "BAD_MAGIC_BYTES" };
  }

  const magic = detectMagic(bytes);
  if (magic === null) {
    return { ok: false, reason: "BAD_MAGIC_BYTES" };
  }

  const contentType = magic === "jpeg" ? "image/jpeg" : "image/webp";
  if (!limits.contentTypeAllowlist.includes(contentType)) {
    return { ok: false, reason: "UNSUPPORTED_TYPE" };
  }

  return { ok: true, bytes };
}

function detectMagic(bytes: Buffer): "jpeg" | "webp" | null {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) {
    return "jpeg";
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(WEBP_RIFF) &&
    bytes.subarray(8, 12).equals(WEBP_TAG)
  ) {
    return "webp";
  }

  return null;
}

/**
 * Content-Type header allowlist check. Separate from the body-bytes check so
 * route handlers can reject before decoding base64 if desired.
 */
export function validateContentType(
  contentType: string | undefined,
  limits: UploadLimits
): { ok: true } | { ok: false; reason: "UNSUPPORTED_TYPE" } {
  if (!contentType) {
    return { ok: false, reason: "UNSUPPORTED_TYPE" };
  }
  const normalized = contentType.toLowerCase().trim().split(";")[0]?.trim();
  if (!normalized || !limits.contentTypeAllowlist.includes(normalized)) {
    return { ok: false, reason: "UNSUPPORTED_TYPE" };
  }
  return { ok: true };
}
