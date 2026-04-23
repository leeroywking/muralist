import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { resolveTier, type TierConfig, type TierId } from "@muralist/config";

export type LimitState = {
  tier: TierId;
  effectiveTier: TierId;
  projectLimit: number | null;
  activeProjectCount: number;
  atLimit: boolean;
  overLimit: boolean;
};

declare module "fastify" {
  interface FastifyRequest {
    limits?: LimitState;
  }
  interface FastifyInstance {
    /**
     * Compute the current tier limit state for `request.user` from MongoDB.
     * Attaches `request.limits`. Must be called after `requireUser`.
     */
    computeLimits: (request: FastifyRequest) => Promise<void>;
    /**
     * Assert that a write is allowed for the current request. Throws a
     * `TierLimitError` (HTTP 403) if the user is in read-only mode
     * (`overLimit === true`). Allows `atLimit === true` so the one-grace-save
     * rule works for `POST /projects`.
     *
     * Use `{ allowInReadOnly: true }` for operations that should bypass the
     * gate (e.g. DELETE is the escape valve).
     */
    assertWriteAllowed: (
      request: FastifyRequest,
      opts?: { allowInReadOnly?: boolean }
    ) => void;
  }
}

export type TierEnforcementPluginOptions = {
  tierConfig: TierConfig;
};

export class TierLimitError extends Error {
  readonly statusCode = 403;
  readonly code = "OVER_TIER_LIMIT";
  constructor(message = "Account is over the tier project limit") {
    super(message);
    this.name = "TierLimitError";
  }
}

export const tierEnforcementPlugin = fp<TierEnforcementPluginOptions>(
  async (app, opts) => {
    const { tierConfig } = opts;

    app.decorate(
      "computeLimits",
      async function computeLimits(request: FastifyRequest) {
        if (!request.user) {
          throw new Error(
            "computeLimits requires request.user — register requireUser first"
          );
        }

        const user = await app.mongo.users.findOne({ sub: request.user.sub });

        const tier: TierId = (user?.tier ?? "free") as TierId;
        const subscriptionStatus = user?.subscriptionStatus ?? "none";
        const effectiveTier: TierId =
          tier === "paid" && subscriptionStatus === "active" ? "paid" : "free";

        const tierDef = resolveTier(tierConfig, effectiveTier);
        const projectLimit = tierDef.projectLimit;

        const activeProjectCount = await app.mongo.projects.countDocuments({
          userId: request.user.sub,
          status: "active"
        });

        const atLimit =
          projectLimit !== null && activeProjectCount === projectLimit;
        const overLimit =
          projectLimit !== null && activeProjectCount > projectLimit;

        request.limits = {
          tier,
          effectiveTier,
          projectLimit,
          activeProjectCount,
          atLimit,
          overLimit
        };
      }
    );

    app.decorate(
      "assertWriteAllowed",
      function assertWriteAllowed(
        request: FastifyRequest,
        opts?: { allowInReadOnly?: boolean }
      ) {
        if (opts?.allowInReadOnly) return;
        if (!request.limits) {
          throw new Error(
            "assertWriteAllowed requires request.limits — call computeLimits first"
          );
        }
        if (request.limits.overLimit) {
          throw new TierLimitError();
        }
      }
    );
  },
  {
    name: "muralist-tier-enforcement",
    fastify: "4.x",
    dependencies: ["muralist-mongo"]
  }
);
