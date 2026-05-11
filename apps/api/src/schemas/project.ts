import { z } from "zod";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COVERAGE_EPSILON = 0.01;
const FRACTION_EPSILON = 0.001;

const hexColorSchema = z.string().regex(HEX_COLOR, "hex color must be #RRGGBB");

const classificationSchema = z.enum(["buy", "mix", "absorb"]);

const paletteColorSchema = z.object({
  id: z.string().min(1).max(100),
  hex: hexColorSchema,
  coverage: z.number().min(0).max(1),
  classification: classificationSchema.optional(),
  // User-toggled flag: when true the color is omitted from the estimate
  // and the maquette PDF's swatch table, and its assigned pixels render as
  // a hatch in the flatten preview. Optional so legacy payloads still
  // validate. Coverage stays at its original value either way — disabling
  // does not renormalize the remaining colors.
  disabled: z.boolean().optional(),
  // User-toggled flag: when true the color is protected from Auto-combine
  // absorbing it into another swatch. Other (unlocked) colors can still
  // absorb INTO a locked color. Optional, defaults to false.
  locked: z.boolean().optional()
});

const mergeOperationSchema = z.object({
  id: z.string().min(1).max(100),
  sourceIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  keeperId: z.string().min(1).max(100),
  appliedAt: z.string().datetime()
});

const mixComponentSchema = z.object({
  colorId: z.string().min(1).max(100),
  fraction: z.number().min(0).max(1)
});

const mixRecipeSchema = z
  .object({
    targetColorId: z.string().min(1).max(100),
    components: z.array(mixComponentSchema).min(1).max(10)
  })
  .refine(
    (recipe) => {
      const sum = recipe.components.reduce((acc, c) => acc + c.fraction, 0);
      return Math.abs(sum - 1) <= FRACTION_EPSILON;
    },
    { message: "mix recipe fractions must sum to 1.0 within ε" }
  );

export const paletteJsonSchema = z
  .object({
    colors: z.array(paletteColorSchema).min(1).max(200),
    originalColors: z.array(paletteColorSchema).max(1000).optional(),
    merges: z.array(mergeOperationSchema).max(200).optional(),
    mixRecipes: z.array(mixRecipeSchema).max(200).optional(),
    finishOverrides: z.record(z.string().max(100), z.string().max(100)).optional(),
    coatsOverrides: z.record(z.string().max(100), z.number().int().min(1).max(10)).optional()
  })
  .refine(
    (palette) => {
      const sum = palette.colors.reduce((acc, c) => acc + c.coverage, 0);
      return Math.abs(sum - 1) <= COVERAGE_EPSILON;
    },
    { message: "palette coverage must sum to 1.0 within ε" }
  );

const wallDimensionsSchema = z
  .object({
    lengthInches: z.number().positive().finite().optional(),
    heightInches: z.number().positive().finite().optional()
  })
  .optional();

export const projectMetadataSchema = z.object({
  notes: z.string().max(2000).optional(),
  wallDimensions: wallDimensionsSchema
});

const projectNameSchema = z.string().min(1).max(200);

// Base64-encoded image payload. The byte-level validation (magic bytes, size
// cap) happens in `imageValidation.ts`; zod only checks string shape.
const base64ImageSchema = z
  .string()
  .min(1)
  // Generous character cap — the byte-accurate per-artifact check lives in
  // imageValidation.ts (reads maxBytes from config/upload-limits.yaml). This
  // just rejects obviously-oversized payloads before base64 decode. 400 KB
  // sanitized bytes → ~547k base64 chars; 600k gives padding headroom. Raise
  // if the yaml cap goes past ~450 KB.
  .max(600_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "payload must be base64");

export const createProjectSchema = z.object({
  name: projectNameSchema,
  palette: paletteJsonSchema,
  image: base64ImageSchema,
  thumbnail: base64ImageSchema,
  metadata: projectMetadataSchema.optional()
});

export const updatePaletteSchema = z.object({
  palette: paletteJsonSchema
});

export const updateImageSchema = z.object({
  image: base64ImageSchema
});

export const updateThumbnailSchema = z.object({
  thumbnail: base64ImageSchema
});

export const updateMetadataSchema = z.object({
  name: projectNameSchema.optional(),
  metadata: projectMetadataSchema.optional()
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdatePaletteInput = z.infer<typeof updatePaletteSchema>;
export type UpdateImageInput = z.infer<typeof updateImageSchema>;
export type UpdateThumbnailInput = z.infer<typeof updateThumbnailSchema>;
export type UpdateMetadataInput = z.infer<typeof updateMetadataSchema>;
export type PaletteJsonInput = z.infer<typeof paletteJsonSchema>;
