// Client-side upload sanitization pipeline.
//
// Runs entirely in the browser: validates extension + magic bytes, decodes
// the user's image with `createImageBitmap`, and re-encodes sanitized +
// thumbnail JPEGs at the caps from `config/upload-limits.yaml`. The server
// only ever sees these re-encoded artifacts — the original file bytes never
// leave the browser. See docs/plans/persistence-and-auth-backend.md §1 step
// 27 and §2.1 for the full sanitization contract.
//
// This file is UI-skeleton per §1 step 30: not yet wired into
// PrototypeApp.tsx. The future UI round consumes it.

import type { UploadLimits } from "@muralist/config";

export type SanitizedUpload = {
  sanitized: Blob;
  thumbnail: Blob;
  bytes: { sanitized: number; thumbnail: number };
};

export type UploadSanitizationReason =
  | "EXTENSION_NOT_ALLOWED"
  | "MAGIC_BYTES_MISMATCH"
  | "DECODE_FAILED"
  | "OFFSCREEN_CANVAS_UNAVAILABLE"
  | "SANITIZED_OVER_CAP"
  | "THUMBNAIL_OVER_CAP";

export class UploadSanitizationError extends Error {
  readonly reason: UploadSanitizationReason;

  constructor(reason: UploadSanitizationReason, message: string) {
    super(message);
    this.name = "UploadSanitizationError";
    this.reason = reason;
  }
}

const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".webp", ".png"] as const;

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function matchesJpegMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function matchesWebpMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // "RIFF" ____ "WEBP"
  return (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  );
}

// PNG signature: 89 50 4E 47 0D 0A 1A 0A
function matchesPngMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

export async function verifyMagicBytes(file: Blob): Promise<void> {
  const head = file.slice(0, 16);
  const buffer = await head.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (
    !matchesJpegMagic(bytes) &&
    !matchesWebpMagic(bytes) &&
    !matchesPngMagic(bytes)
  ) {
    throw new UploadSanitizationError(
      "MAGIC_BYTES_MISMATCH",
      "File contents do not match JPEG, WebP, or PNG magic bytes."
    );
  }
}

type OffscreenCanvasCtor = new (
  width: number,
  height: number
) => OffscreenCanvas;

function getOffscreenCanvasCtor(): OffscreenCanvasCtor {
  const ctor = (globalThis as { OffscreenCanvas?: OffscreenCanvasCtor })
    .OffscreenCanvas;
  if (!ctor) {
    throw new UploadSanitizationError(
      "OFFSCREEN_CANVAS_UNAVAILABLE",
      "OffscreenCanvas is required to sanitize uploads."
    );
  }
  return ctor;
}

function computeTargetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  longEdge: number
): { width: number; height: number } {
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= longEdge) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const scale = longEdge / longest;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

async function encodeArtifact(
  bitmap: ImageBitmap,
  longEdge: number,
  jpegQuality: number
): Promise<Blob> {
  const OffscreenCanvasCtor = getOffscreenCanvasCtor();
  const { width, height } = computeTargetDimensions(
    bitmap.width,
    bitmap.height,
    longEdge
  );
  const canvas = new OffscreenCanvasCtor(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new UploadSanitizationError(
      "OFFSCREEN_CANVAS_UNAVAILABLE",
      "Could not acquire a 2D context from OffscreenCanvas."
    );
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({
    type: "image/jpeg",
    quality: jpegQuality
  });
}

/**
 * Sanitizes a user-supplied image file for persistence.
 *
 * Pipeline:
 *   1. Extension allowlist (.jpg, .jpeg, .webp).
 *   2. Magic-byte check on the first 16 bytes.
 *   3. `createImageBitmap` decode.
 *   4. Draw + JPEG re-encode at `limits.sanitizedImage.longEdge`.
 *   5. Second pass for `limits.thumbnail.longEdge`.
 *   6. Verify both blobs are under their configured byte caps.
 *
 * Throws `UploadSanitizationError` with a specific `reason` on any failure.
 */
export async function sanitizeUpload(
  file: File,
  limits: UploadLimits
): Promise<SanitizedUpload> {
  if (!hasAllowedExtension(file.name)) {
    throw new UploadSanitizationError(
      "EXTENSION_NOT_ALLOWED",
      `File extension not allowed. Accepted: ${ALLOWED_EXTENSIONS.join(", ")}.`
    );
  }

  await verifyMagicBytes(file);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (cause) {
    throw new UploadSanitizationError(
      "DECODE_FAILED",
      `createImageBitmap failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  try {
    const sanitized = await encodeArtifact(
      bitmap,
      limits.sanitizedImage.longEdge,
      limits.sanitizedImage.jpegQuality
    );
    const thumbnail = await encodeArtifact(
      bitmap,
      limits.thumbnail.longEdge,
      limits.thumbnail.jpegQuality
    );

    if (sanitized.size > limits.sanitizedImage.maxBytes) {
      throw new UploadSanitizationError(
        "SANITIZED_OVER_CAP",
        `sanitized exceeds ${limits.sanitizedImage.maxBytes} bytes; check limits.`
      );
    }
    if (thumbnail.size > limits.thumbnail.maxBytes) {
      throw new UploadSanitizationError(
        "THUMBNAIL_OVER_CAP",
        `thumbnail exceeds ${limits.thumbnail.maxBytes} bytes; check limits.`
      );
    }

    return {
      sanitized,
      thumbnail,
      bytes: { sanitized: sanitized.size, thumbnail: thumbnail.size }
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Converts a Blob to raw base64 (no `data:...;base64,` prefix).
 * Used by `apiClient` to encode sanitized + thumbnail blobs for JSON bodies.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(
        new Error(
          reader.error?.message ?? "FileReader failed to read blob as DataURL."
        )
      );
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned a non-string DataURL result."));
        return;
      }
      const commaIndex = result.indexOf(",");
      if (commaIndex < 0) {
        reject(new Error("DataURL result missing base64 separator."));
        return;
      }
      resolve(result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(blob);
  });
}
