import type { Binary, ObjectId } from "mongodb";

export type TierId = "free" | "paid";
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "none";
export type ProjectStatus = "active" | "trashed";

export type LinkedProvider = {
  providerId: string;
  providerSub: string;
  email?: string;
  linkedAt: Date;
};

export type ProSettings = {
  autoCombineSensitivity?: "conservative" | "balanced" | "aggressive" | "custom";
  residualThreshold?: number;
  mixCoveragePercent?: number;
};

export type UserDoc = {
  _id?: ObjectId;
  sub: string;
  email?: string;
  tier: TierId;
  subscriptionStatus: SubscriptionStatus;
  activeProjectCount: number;
  atLimit: boolean;
  overLimit: boolean;
  /**
   * Populated list of the user's linked OAuth accounts.
   *
   * DEFERRED: this field is declared but not wired. Better Auth owns the
   * canonical `account` collection; mirroring it here would require a
   * `databaseHooks.account.create.after` hook to append on every
   * provider-link, plus a delete hook to prune. Until that hook lands, the
   * array stays empty and `/me.linkedProviders` reads as `[]`. Consumers
   * (Settings view) should treat this field as a UX enhancement, not a
   * source of truth — the authoritative linking state lives in
   * `better-auth.account`. Tracked in docs/RETENTION_POLICY.md.
   */
  providers: LinkedProvider[];
  proSettings: ProSettings;
  createdAt: Date;
  lastSignInAt?: Date;
  deletionPendingAt?: Date;
};

export type PaletteColor = {
  id: string;
  hex: string;
  coverage: number;
  classification?: "buy" | "mix" | "absorb";
};

export type MergeOperation = {
  id: string;
  sourceIds: string[];
  keeperId: string;
  appliedAt: string;
};

export type PaletteJson = {
  colors: PaletteColor[];
  originalColors?: PaletteColor[];
  merges?: MergeOperation[];
  mixRecipes?: unknown[];
  finishOverrides?: Record<string, string>;
  coatsOverrides?: Record<string, number>;
};

export type ProjectMetadata = {
  notes?: string;
  wallDimensions?: {
    lengthInches?: number;
    heightInches?: number;
  };
};

export type ProjectDoc = {
  _id?: ObjectId;
  userId: string;
  name: string;
  palette: PaletteJson;
  sanitizedImage: Binary;
  metadata: ProjectMetadata;
  version: number;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
  lastViewedAt: Date;
  deletedAt?: Date;
};

export type ThumbnailDoc = {
  _id?: ObjectId;
  projectId: string;
  userId: string;
  thumbnail: Binary;
  name: string;
  lastViewedAt: Date;
  status: ProjectStatus;
  deletedAt?: Date;
};

export type SessionUser = {
  sub: string;
  email?: string;
  sessionId: string;
};

// LimitState lives in plugins/tierEnforcement.ts with the richer shape that
// includes tier + effectiveTier. Import from there to avoid divergent
// definitions.
export type { LimitState } from "./plugins/tierEnforcement.js";
