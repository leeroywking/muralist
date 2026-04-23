import test from "node:test";
import assert from "node:assert/strict";
import {
  loadTierConfig,
  validateTierConfig,
  resolveTier,
  type TierConfig
} from "../src/index.js";

test("tier config loads and validates", async () => {
  const config = await loadTierConfig();
  assert.equal(config.version, 1);
  assert.equal(config.tiers.length, 2);
});

test("free tier defaults to projectLimit=3", async () => {
  const config = await loadTierConfig();
  const free = resolveTier(config, "free");
  assert.equal(free.projectLimit, 3);
});

test("paid tier has unlimited projects (null)", async () => {
  const config = await loadTierConfig();
  const paid = resolveTier(config, "paid");
  assert.equal(paid.projectLimit, null);
});

test("paid tier exposes recurring + one_time subscription options", async () => {
  const config = await loadTierConfig();
  const paid = resolveTier(config, "paid");
  const kinds = paid.subscriptionOptions.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ["one_time", "recurring"]);
});

test("resolveTier throws on unknown tier id", async () => {
  const config = await loadTierConfig();
  assert.throws(() => resolveTier(config, "enterprise" as never), /Tier enterprise not found/);
});

test("validator rejects empty tiers list", () => {
  assert.throws(
    () => validateTierConfig({ version: 1, tiers: [] }),
    /at least one tier/
  );
});

test("validator rejects unknown tier id", () => {
  const config = buildFixture();
  (config.tiers[0] as { id: string }).id = "enterprise";
  assert.throws(() => validateTierConfig(config), /Unknown tier id/);
});

test("validator rejects duplicate tier ids", () => {
  const config = buildFixture();
  config.tiers.push({ ...config.tiers[0]! });
  assert.throws(() => validateTierConfig(config), /Duplicate tier id/);
});

test("validator rejects negative projectLimit", () => {
  const config = buildFixture();
  config.tiers[0]!.projectLimit = -1;
  assert.throws(() => validateTierConfig(config), /projectLimit must be null/);
});

test("validator rejects non-integer projectLimit", () => {
  const config = buildFixture();
  config.tiers[0]!.projectLimit = 2.5;
  assert.throws(() => validateTierConfig(config), /projectLimit must be null/);
});

test("validator rejects missing free tier", () => {
  const config: TierConfig = {
    version: 1,
    tiers: [
      {
        id: "paid",
        projectLimit: null,
        subscriptionOptions: [{ kind: "recurring" }]
      }
    ]
  };
  assert.throws(() => validateTierConfig(config), /define a free tier/);
});

test("validator rejects missing paid tier", () => {
  const config: TierConfig = {
    version: 1,
    tiers: [
      {
        id: "free",
        projectLimit: 3,
        subscriptionOptions: []
      }
    ]
  };
  assert.throws(() => validateTierConfig(config), /define a paid tier/);
});

test("validator rejects unknown subscription option kind", () => {
  const config = buildFixture();
  (config.tiers[1]!.subscriptionOptions[0] as { kind: string }).kind = "bogus";
  assert.throws(() => validateTierConfig(config), /unknown subscriptionOption\.kind/);
});

test("validator rejects non-positive one_time.windowDays", () => {
  const config = buildFixture();
  const opt = config.tiers[1]!.subscriptionOptions.find((o) => o.kind === "one_time");
  if (!opt || opt.kind !== "one_time") throw new Error("fixture missing one_time option");
  opt.windowDays = 0;
  assert.throws(() => validateTierConfig(config), /one_time\.windowDays/);
});

test("validator accepts one_time.windowDays=null (not yet configured)", () => {
  const config = buildFixture();
  const opt = config.tiers[1]!.subscriptionOptions.find((o) => o.kind === "one_time");
  if (!opt || opt.kind !== "one_time") throw new Error("fixture missing one_time option");
  opt.windowDays = null;
  validateTierConfig(config);
});

function buildFixture(): TierConfig {
  return {
    version: 1,
    tiers: [
      {
        id: "free",
        projectLimit: 3,
        subscriptionOptions: []
      },
      {
        id: "paid",
        projectLimit: null,
        subscriptionOptions: [
          { kind: "recurring" },
          { kind: "one_time", windowDays: null }
        ]
      }
    ]
  };
}
