import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Days before a pending account deletion becomes eligible for lazy purge. */
export const ACCOUNT_DELETION_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isDeletionElapsed(deletionPendingAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - deletionPendingAt.getTime() >= ACCOUNT_DELETION_WINDOW_DAYS * DAY_MS;
}

/**
 * Hard-purge every row tied to a user. Called by the lazy-purge path in /me
 * once the 30-day window has elapsed, and potentially by future scheduled
 * jobs if we add a cron to firm up the guarantee.
 */
export async function purgeUser(
  app: FastifyInstance,
  sub: string
): Promise<void> {
  await app.mongo.projects.deleteMany({ userId: sub });
  await app.mongo.thumbnails.deleteMany({ userId: sub });
  await app.mongo.users.deleteOne({ sub });
  // Better Auth sessions live in its own collection; the caller can
  // decide whether to also invalidate via `auth.api.signOut` if wanted.
  // For MVP we rely on session cookies expiring naturally.
}

export const accountRoutes = fp(
  async (app: FastifyInstance) => {
    app.delete(
      "/account",
      { preHandler: [app.requireUser] },
      async (request: FastifyRequest) => {
        if (!request.user) {
          throw new Error("/account reached without user");
        }

        const now = new Date();
        await app.mongo.users.updateOne(
          { sub: request.user.sub },
          {
            $set: { deletionPendingAt: now },
            $setOnInsert: {
              sub: request.user.sub,
              email: request.user.email ?? undefined,
              tier: "free",
              subscriptionStatus: "none",
              activeProjectCount: 0,
              atLimit: false,
              overLimit: false,
              providers: [],
              proSettings: {},
              createdAt: now
            }
          },
          { upsert: true }
        );

        const deletionAt = new Date(
          now.getTime() + ACCOUNT_DELETION_WINDOW_DAYS * DAY_MS
        );

        return {
          deletionPendingAt: now.toISOString(),
          deletionAt: deletionAt.toISOString(),
          windowDays: ACCOUNT_DELETION_WINDOW_DAYS
        };
      }
    );

    app.post(
      "/account/delete-cancel",
      { preHandler: [app.requireUser] },
      async (request: FastifyRequest, reply) => {
        if (!request.user) {
          throw new Error("/account/delete-cancel reached without user");
        }

        await app.mongo.users.updateOne(
          { sub: request.user.sub },
          { $unset: { deletionPendingAt: "" } }
        );

        reply.code(204).send();
      }
    );
  },
  {
    name: "muralist-routes-account",
    fastify: "4.x",
    dependencies: ["muralist-mongo", "muralist-require-user"]
  }
);
