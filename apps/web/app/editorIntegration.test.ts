// Tests for the editor ↔ backend integration helpers in
// `editorPersistence.ts`. These cover the pieces that are testable without a
// browser — palette serialization shape, create-payload assembly, hydration
// from a full project, and the error-path branching that `PrototypeApp.tsx`
// relies on when it catches `UnauthenticatedError`, `OverLimitError`, and
// `VersionConflictError`.
//
// The component-level DOM interactions (button clicks, state transitions)
// are covered manually in the preview deploy; see the test plan in the PR
// description.

import test from "node:test";
import assert from "node:assert/strict";

import { createProjectSchema, paletteJsonSchema } from "../../api/src/schemas/project.js";
import {
  OverLimitError,
  UnauthenticatedError,
  VersionConflictError,
  type ProjectFull
} from "./apiClient.js";
import {
  DEFAULT_UPLOAD_LIMITS,
  buildCreateProjectPayload,
  buildPaletteJson,
  getUploadLimits,
  hydrateFromProject,
  readProjectIdFromSearch,
  stripExtension,
  toBackendPaletteColors,
  type EditorPaletteColor,
  type EditorSnapshot
} from "./editorPersistence.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeColor(
  overrides: Partial<EditorPaletteColor> = {}
): EditorPaletteColor {
  return {
    id: overrides.id ?? "color-1",
    hex: overrides.hex ?? "#AABBCC",
    rgb: overrides.rgb ?? [170, 187, 204],
    pixelCount: overrides.pixelCount ?? 1000,
    coveragePercent: overrides.coveragePercent ?? 50
  };
}

const SMALL_BASE64 = "QUFBQQ=="; // 4-byte payload, base64 shape is what zod checks.

function makeSnapshot(partial: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    paletteColors: partial.paletteColors ?? [
      makeColor({ id: "c1", hex: "#112233", coveragePercent: 60 }),
      makeColor({ id: "c2", hex: "#445566", coveragePercent: 40 })
    ],
    originalPaletteColors: partial.originalPaletteColors,
    classifications: partial.classifications ?? {},
    mixRecipes: partial.mixRecipes ?? [],
    colorFinishOverrides: partial.colorFinishOverrides ?? {},
    colorCoatsOverrides: partial.colorCoatsOverrides ?? {}
  };
}

// ---------------------------------------------------------------------------
// Palette serialization
// ---------------------------------------------------------------------------

test("toBackendPaletteColors converts percent → fraction and uppercases hex", () => {
  const result = toBackendPaletteColors([
    makeColor({ id: "a", hex: "#aabbcc", coveragePercent: 75 }),
    makeColor({ id: "b", hex: "#ddeeff", coveragePercent: 25 })
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.id, "a");
  assert.equal(result[0]!.hex, "#AABBCC");
  assert.ok(Math.abs(result[0]!.coverage - 0.75) < 1e-6);
  assert.ok(Math.abs(result[1]!.coverage - 0.25) < 1e-6);
});

test("toBackendPaletteColors renormalises when percents drift off 100", () => {
  const result = toBackendPaletteColors([
    makeColor({ id: "a", coveragePercent: 59.5 }),
    makeColor({ id: "b", coveragePercent: 39.5 })
  ]);
  const sum = result.reduce((acc, c) => acc + c.coverage, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `expected renormalised sum, got ${sum}`);
});

test("toBackendPaletteColors preserves per-color classification when provided", () => {
  const result = toBackendPaletteColors(
    [makeColor({ id: "a" }), makeColor({ id: "b" })],
    { a: "buy", b: "mix" }
  );
  assert.equal(result[0]!.classification, "buy");
  assert.equal(result[1]!.classification, "mix");
});

test("buildPaletteJson omits empty optional sections", () => {
  const palette = buildPaletteJson(makeSnapshot());
  assert.equal(palette.mixRecipes, undefined);
  assert.equal(palette.finishOverrides, undefined);
  assert.equal(palette.coatsOverrides, undefined);
  assert.equal(palette.originalColors, undefined);
});

test("buildPaletteJson preserves merge-reversibility via originalColors", () => {
  const snapshot = makeSnapshot({
    paletteColors: [makeColor({ id: "merged", coveragePercent: 100 })],
    originalPaletteColors: [
      makeColor({ id: "o1", coveragePercent: 50 }),
      makeColor({ id: "o2", coveragePercent: 50 })
    ]
  });
  const palette = buildPaletteJson(snapshot);
  assert.ok(palette.originalColors);
  assert.equal(palette.originalColors!.length, 2);
});

test("buildPaletteJson clamps coats overrides into backend's 1..10 int range", () => {
  const snapshot = makeSnapshot({
    colorCoatsOverrides: {
      "c1": 0,       // below min → clamp to 1
      "c2": 11.7,    // above max → clamp to 10
      "c3": 2.4      // round to 2
    }
  });
  const palette = buildPaletteJson(snapshot);
  assert.deepEqual(palette.coatsOverrides, { c1: 1, c2: 10, c3: 2 });
});

test("buildPaletteJson output passes the backend zod schema", () => {
  const snapshot = makeSnapshot({
    paletteColors: [
      makeColor({ id: "c1", hex: "#112233", coveragePercent: 60 }),
      makeColor({ id: "c2", hex: "#445566", coveragePercent: 40 })
    ],
    classifications: { c1: "buy", c2: "mix" },
    mixRecipes: [
      {
        targetColorId: "c2",
        components: [
          { colorId: "c1", fraction: 0.6 },
          { colorId: "c3", fraction: 0.4 }
        ]
      }
    ],
    colorFinishOverrides: { c1: "satin" },
    colorCoatsOverrides: { c1: 2 }
  });
  const palette = buildPaletteJson(snapshot);
  const result = paletteJsonSchema.safeParse(palette);
  assert.equal(
    result.success,
    true,
    `schema rejected palette: ${result.success ? "" : JSON.stringify(result.error.format())}`
  );
});

// ---------------------------------------------------------------------------
// createProject payload
// ---------------------------------------------------------------------------

test("buildCreateProjectPayload assembles name / image / thumbnail / palette", () => {
  const snapshot = makeSnapshot();
  const payload = buildCreateProjectPayload({
    name: "My Mural",
    snapshot,
    sanitizedImageBase64: SMALL_BASE64,
    thumbnailBase64: SMALL_BASE64
  });
  assert.equal(payload.name, "My Mural");
  assert.equal(payload.image, SMALL_BASE64);
  assert.equal(payload.thumbnail, SMALL_BASE64);
  assert.ok(payload.palette);
  assert.equal(payload.palette.colors.length, 2);
});

test("buildCreateProjectPayload output passes the backend createProject schema", () => {
  const snapshot = makeSnapshot();
  const payload = buildCreateProjectPayload({
    name: "Round-trip test",
    snapshot,
    sanitizedImageBase64: SMALL_BASE64,
    thumbnailBase64: SMALL_BASE64
  });
  const result = createProjectSchema.safeParse(payload);
  assert.equal(
    result.success,
    true,
    `schema rejected payload: ${result.success ? "" : JSON.stringify(result.error.format())}`
  );
});

// ---------------------------------------------------------------------------
// Mocked API round-trip (save + load flow surface area)
// ---------------------------------------------------------------------------

test("save-to-backend flow: mocked createProject receives a schema-valid payload", async () => {
  const seen: unknown[] = [];
  const mockCreate = async (payload: unknown) => {
    seen.push(payload);
    const parseResult = createProjectSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new Error(
        `payload failed schema: ${JSON.stringify(parseResult.error.format())}`
      );
    }
    return { id: "new-id", version: 1 } as unknown as ProjectFull;
  };

  const payload = buildCreateProjectPayload({
    name: "Mural",
    snapshot: makeSnapshot(),
    sanitizedImageBase64: SMALL_BASE64,
    thumbnailBase64: SMALL_BASE64
  });
  const result = await mockCreate(payload);

  assert.equal(seen.length, 1);
  const received = seen[0] as {
    name: string;
    image: string;
    thumbnail: string;
    palette: { colors: unknown[] };
  };
  assert.equal(received.name, "Mural");
  assert.equal(received.image, SMALL_BASE64);
  assert.equal(received.thumbnail, SMALL_BASE64);
  assert.equal(received.palette.colors.length, 2);
  assert.equal((result as { id: string }).id, "new-id");
});

// ---------------------------------------------------------------------------
// Hydration (backend → editor)
// ---------------------------------------------------------------------------

function makeProjectFixture(overrides: Partial<ProjectFull> = {}): ProjectFull {
  return {
    id: overrides.id ?? "proj-1",
    userId: overrides.userId ?? "user-1",
    name: overrides.name ?? "Fixture mural",
    palette: overrides.palette ?? {
      colors: [
        { id: "c1", hex: "#112233", coverage: 0.6, classification: "buy" },
        { id: "c2", hex: "#445566", coverage: 0.4, classification: "mix" }
      ],
      mixRecipes: [
        {
          targetColorId: "c2",
          components: [
            { colorId: "c1", fraction: 0.5 },
            { colorId: "c3", fraction: 0.5 }
          ]
        }
      ],
      finishOverrides: { c1: "satin" },
      coatsOverrides: { c1: 2 }
    },
    sanitizedImage: overrides.sanitizedImage ?? SMALL_BASE64,
    metadata: overrides.metadata ?? {},
    version: overrides.version ?? 3,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-23T00:00:00.000Z",
    lastViewedAt: overrides.lastViewedAt ?? "2026-04-23T00:00:00.000Z"
  };
}

test("hydrateFromProject maps backend fields onto editor state", () => {
  const project = makeProjectFixture();
  const state = hydrateFromProject(project);
  assert.equal(state.projectId, "proj-1");
  assert.equal(state.version, 3);
  assert.equal(state.name, "Fixture mural");
  assert.equal(state.paletteColors.length, 2);
  assert.equal(state.paletteColors[0]!.hex, "#112233");
  // Coverage ↔ percent conversion.
  assert.ok(Math.abs(state.paletteColors[0]!.coveragePercent - 60) < 1e-6);
  // Classifications propagate.
  assert.deepEqual(state.classifications, { c1: "buy", c2: "mix" });
  // Mix recipes pass through untouched.
  assert.equal(state.mixRecipes.length, 1);
  assert.equal(state.mixRecipes[0]!.targetColorId, "c2");
  // Overrides copied by value.
  assert.deepEqual(state.colorFinishOverrides, { c1: "satin" });
  assert.deepEqual(state.colorCoatsOverrides, { c1: 2 });
  // Image is wrapped as a data URL.
  assert.ok(state.imageDataUrl.startsWith("data:image/jpeg;base64,"));
});

test("hydrateFromProject handles a palette with no optional sections", () => {
  const project = makeProjectFixture({
    palette: {
      colors: [{ id: "solo", hex: "#ffffff", coverage: 1 }]
    }
  });
  const state = hydrateFromProject(project);
  assert.equal(state.paletteColors.length, 1);
  assert.equal(state.mixRecipes.length, 0);
  assert.deepEqual(state.colorFinishOverrides, {});
  assert.deepEqual(state.colorCoatsOverrides, {});
});

// ---------------------------------------------------------------------------
// Error class instance checks — documents the branches PrototypeApp relies on.
// ---------------------------------------------------------------------------

test("UnauthenticatedError instance check (401 → redirect to /signin)", () => {
  const err = new UnauthenticatedError({ error: "UNAUTH" });
  assert.ok(err instanceof UnauthenticatedError);
  assert.equal(err.status, 401);
});

test("OverLimitError instance check (403 → inline limit copy)", () => {
  const err = new OverLimitError({ error: "OVER_TIER_LIMIT" });
  assert.ok(err instanceof OverLimitError);
  assert.equal(err.status, 403);
  assert.equal(err.code, "OVER_TIER_LIMIT");
});

test("VersionConflictError instance check (409 → conflict banner)", () => {
  const err = new VersionConflictError({ error: "VERSION_CONFLICT" });
  assert.ok(err instanceof VersionConflictError);
  assert.equal(err.status, 409);
});

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

test("stripExtension drops the last extension and preserves earlier dots", () => {
  assert.equal(stripExtension("mural.v2.jpg"), "mural.v2");
  assert.equal(stripExtension("mural"), "mural");
  assert.equal(stripExtension(""), "Untitled project");
  assert.equal(stripExtension(".hidden"), ".hidden");
});

test("readProjectIdFromSearch pulls the project query param out", () => {
  assert.equal(readProjectIdFromSearch("?project=abc"), "abc");
  assert.equal(readProjectIdFromSearch("project=abc"), "abc");
  assert.equal(readProjectIdFromSearch("?foo=bar&project=xyz"), "xyz");
  assert.equal(readProjectIdFromSearch(""), null);
  assert.equal(readProjectIdFromSearch("?project="), null);
  assert.equal(readProjectIdFromSearch("?other=1"), null);
});

test("getUploadLimits returns the fallback defaults (no backend endpoint yet)", async () => {
  const limits = await getUploadLimits();
  assert.deepEqual(limits, DEFAULT_UPLOAD_LIMITS);
});
