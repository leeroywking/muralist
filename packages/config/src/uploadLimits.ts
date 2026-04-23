import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type UploadArtifactLimits = {
  maxBytes: number;
  longEdge: number;
  jpegQuality: number;
};

export type UploadLimits = {
  version: number;
  sanitizedImage: UploadArtifactLimits;
  thumbnail: UploadArtifactLimits;
  contentTypeAllowlist: string[];
};

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const limitsPath = path.resolve(currentDir, "../../../config/upload-limits.yaml");

export async function loadUploadLimits(): Promise<UploadLimits> {
  const raw = await readFile(limitsPath, "utf8");
  const parsed = parse(raw) as UploadLimits;
  validateUploadLimits(parsed);
  return parsed;
}

export function validateUploadLimits(limits: UploadLimits) {
  if (!limits) {
    throw new Error("Upload limits config is empty.");
  }

  validateArtifact("sanitizedImage", limits.sanitizedImage);
  validateArtifact("thumbnail", limits.thumbnail);

  if (!Array.isArray(limits.contentTypeAllowlist) || limits.contentTypeAllowlist.length === 0) {
    throw new Error("Upload limits must include a non-empty contentTypeAllowlist.");
  }

  for (const type of limits.contentTypeAllowlist) {
    if (typeof type !== "string" || !type.startsWith("image/")) {
      throw new Error(
        `Upload limits contentTypeAllowlist entries must be image/* content types. Got: ${type}`
      );
    }
  }
}

function validateArtifact(label: string, artifact: UploadArtifactLimits) {
  if (!artifact) {
    throw new Error(`Upload limits missing ${label} section.`);
  }
  if (!(Number.isInteger(artifact.maxBytes) && artifact.maxBytes > 0)) {
    throw new Error(`Upload limits ${label}.maxBytes must be a positive integer.`);
  }
  if (!(Number.isInteger(artifact.longEdge) && artifact.longEdge > 0)) {
    throw new Error(`Upload limits ${label}.longEdge must be a positive integer.`);
  }
  if (!(artifact.jpegQuality > 0 && artifact.jpegQuality <= 1)) {
    throw new Error(`Upload limits ${label}.jpegQuality must be in (0, 1].`);
  }
}
