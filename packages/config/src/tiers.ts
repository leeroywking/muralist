import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type TierId = "free" | "paid";

export type SubscriptionOptionRecurring = { kind: "recurring" };

export type SubscriptionOptionOneTime = {
  kind: "one_time";
  windowDays: number | null;
};

export type SubscriptionOption = SubscriptionOptionRecurring | SubscriptionOptionOneTime;

export type TierDefinition = {
  id: TierId;
  projectLimit: number | null;
  subscriptionOptions: SubscriptionOption[];
};

export type TierConfig = {
  version: number;
  tiers: TierDefinition[];
};

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const tiersPath = path.resolve(currentDir, "../../../config/tiers.yaml");

export async function loadTierConfig(): Promise<TierConfig> {
  const raw = await readFile(tiersPath, "utf8");
  const parsed = parse(raw) as TierConfig;
  validateTierConfig(parsed);
  return parsed;
}

export function validateTierConfig(config: TierConfig) {
  if (!config?.tiers?.length) {
    throw new Error("Tier config must include at least one tier.");
  }

  const seenIds = new Set<TierId>();
  for (const tier of config.tiers) {
    if (!tier.id) {
      throw new Error("Each tier must have an id.");
    }
    if (tier.id !== "free" && tier.id !== "paid") {
      throw new Error(`Unknown tier id: ${tier.id}. Expected "free" or "paid".`);
    }
    if (seenIds.has(tier.id)) {
      throw new Error(`Duplicate tier id: ${tier.id}.`);
    }
    seenIds.add(tier.id);

    if (tier.projectLimit !== null && !(Number.isInteger(tier.projectLimit) && tier.projectLimit >= 0)) {
      throw new Error(
        `Tier ${tier.id} projectLimit must be null (unlimited) or a non-negative integer.`
      );
    }

    if (!Array.isArray(tier.subscriptionOptions)) {
      throw new Error(`Tier ${tier.id} subscriptionOptions must be an array.`);
    }

    for (const option of tier.subscriptionOptions) {
      if (option.kind !== "recurring" && option.kind !== "one_time") {
        throw new Error(
          `Tier ${tier.id} has an unknown subscriptionOption.kind: ${(option as { kind: string }).kind}.`
        );
      }
      if (option.kind === "one_time") {
        if (
          option.windowDays !== null &&
          !(Number.isInteger(option.windowDays) && option.windowDays > 0)
        ) {
          throw new Error(
            `Tier ${tier.id} one_time.windowDays must be null or a positive integer.`
          );
        }
      }
    }
  }

  if (!seenIds.has("free")) {
    throw new Error("Tier config must define a free tier.");
  }
  if (!seenIds.has("paid")) {
    throw new Error("Tier config must define a paid tier.");
  }
}

export function resolveTier(config: TierConfig, id: TierId): TierDefinition {
  const tier = config.tiers.find((t) => t.id === id);
  if (!tier) {
    throw new Error(`Tier ${id} not found in config.`);
  }
  return tier;
}
