import { z } from "zod";

const sensitivitySchema = z.enum(["conservative", "balanced", "aggressive", "custom"]);

export const proSettingsSchema = z.object({
  autoCombineSensitivity: sensitivitySchema.optional(),
  residualThreshold: z.number().finite().min(0).max(100).optional(),
  mixCoveragePercent: z.number().finite().min(0).max(100).optional()
});

export type ProSettingsInput = z.infer<typeof proSettingsSchema>;

// Response shape for GET /me. Zod is used here to keep the contract explicit
// and shared between the route handler and any future client-side validator.
export const meResponseSchema = z.object({
  sub: z.string(),
  email: z.string().email().optional(),
  tier: z.enum(["free", "paid"]),
  effectiveTier: z.enum(["free", "paid"]),
  subscriptionStatus: z.enum(["active", "past_due", "canceled", "none"]),
  projectLimit: z.number().int().min(0).nullable(),
  activeProjectCount: z.number().int().min(0),
  atLimit: z.boolean(),
  overLimit: z.boolean(),
  linkedProviders: z.array(
    z.object({
      providerId: z.string(),
      email: z.string().email().optional(),
      linkedAt: z.string().datetime()
    })
  ),
  proSettings: proSettingsSchema,
  deletionPendingAt: z.string().datetime().optional()
});

export type MeResponse = z.infer<typeof meResponseSchema>;
