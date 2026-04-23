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

export type LimitState = {
  activeProjectCount: number;
  projectLimit: number | null;
  atLimit: boolean;
  overLimit: boolean;
};
