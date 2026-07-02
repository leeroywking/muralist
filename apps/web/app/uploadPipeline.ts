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

const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".webp", ".png", ".svg"] as const;

// Detected input family. SVG is vector/XML and takes a different decode path
// (an isolated <img> rasterize) than the raster formats; both re-encode to the
// same JPEG artifacts, so nothing downstream ever sees the original bytes.
export type DetectedImageKind = "raster" | "svg";

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

// SVG is XML/text, not a binary magic number. Look for the root <svg tag in
// the head, tolerating a leading BOM, XML declaration, DOCTYPE, or comments.
function matchesSvgMagic(bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).toLowerCase();
  return text.includes("<svg");
}

export async function verifyMagicBytes(file: Blob): Promise<DetectedImageKind> {
  // Read enough to clear an XML declaration / DOCTYPE / comment before <svg>.
  const head = file.slice(0, 1024);
  const buffer = await head.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (matchesJpegMagic(bytes) || matchesWebpMagic(bytes) || matchesPngMagic(bytes)) {
    return "raster";
  }
  if (matchesSvgMagic(bytes)) {
    return "svg";
  }
  throw new UploadSanitizationError(
    "MAGIC_BYTES_MISMATCH",
    "File contents do not match JPEG, WebP, PNG, or SVG magic bytes."
  );
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

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("SVG could not be decoded as an image."));
    image.src = url;
  });
}

/**
 * Rasterize an SVG to an ImageBitmap. `createImageBitmap` is unreliable on SVG
 * (sizeless documents, cross-browser gaps), so load it as an isolated `<img>` —
 * which runs SVG in secure-static mode (no scripts, no external subresource
 * loads, so the canvas is never tainted) — then draw it onto a canvas scaled so
 * the long edge reaches `longEdge` for a crisp raster of the vector. Output is
 * a raster bitmap, so any SVG payload is neutralized before it reaches the
 * shared JPEG encoder or the server.
 */
async function rasterizeSvgToBitmap(file: Blob, longEdge: number): Promise<ImageBitmap> {
  if (typeof document === "undefined") {
    throw new UploadSanitizationError(
      "DECODE_FAILED",
      "SVG rasterization requires a DOM."
    );
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    // Chrome gives a sizeless SVG-in-<img> a 300×150 intrinsic box; use that
    // aspect and scale the vector up so the long edge ≈ longEdge.
    let width = image.naturalWidth || 300;
    let height = image.naturalHeight || 150;
    const scale = longEdge / Math.max(width, height);
    if (scale > 1) {
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
    const OffscreenCanvasCtor = getOffscreenCanvasCtor();
    const canvas = new OffscreenCanvasCtor(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new UploadSanitizationError(
        "OFFSCREEN_CANVAS_UNAVAILABLE",
        "Could not acquire a 2D context to rasterize the SVG."
      );
    }
    // SVGs are commonly transparent; JPEG has no alpha, so matte to white first
    // to avoid a black background bleeding into the palette.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return await createImageBitmap(canvas);
  } catch (cause) {
    if (cause instanceof UploadSanitizationError) throw cause;
    throw new UploadSanitizationError(
      "DECODE_FAILED",
      `SVG rasterization failed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  } finally {
    URL.revokeObjectURL(url);
  }
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
 *   1. Extension allowlist (.jpg, .jpeg, .webp, .png, .svg).
 *   2. Magic-byte check (SVG detected by its <svg> root tag).
 *   3. Decode: `createImageBitmap` for raster, isolated <img> rasterize for SVG.
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

  const kind = await verifyMagicBytes(file);

  let bitmap: ImageBitmap;
  if (kind === "svg") {
    bitmap = await rasterizeSvgToBitmap(file, limits.sanitizedImage.longEdge);
  } else {
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
