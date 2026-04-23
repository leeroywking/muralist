import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { proSettingsSchema } from "../schemas/me.js";
import type { UserDoc } from "../types.js";

/**
 * Read or lazily-create the product-side user record for the authenticated
 * session. Better Auth owns the identity table; this record holds our
 * product-specific fields (tier, proSettings, etc).
 */
async function readOrCreateUserDoc(
  app: FastifyInstance,
  sub: string,
  email: string | null | undefined
): Promise<UserDoc> {
  const existing = await app.mongo.users.findOne({ sub });
  if (existing) return existing;

  const now = new Date();
  const doc: UserDoc = {
    sub,
    email: email ?? undefined,
    tier: "free",
    subscriptionStatus: "none",
    activeProjectCount: 0,
    atLimit: false,
    overLimit: false,
    providers: [],
    proSettings: {},
    createdAt: now,
    lastSignInAt: now
  };
  await app.mongo.users.insertOne(doc);
  return doc;
}

export const meRoutes = fp(
  async (app: FastifyInstance) => {
    app.get(
      "/me",
      {
        preHandler: [
          app.requireUser,
          async (req: FastifyRequest) => {
            await app.computeLimits(req);
          }
        ]
      },
      async (request) => {
        if (!request.user || !request.limits) {
          // Defensive: preHandler chain should have set both.
          throw new Error("me route reached without user + limits");
        }

        const doc = await readOrCreateUserDoc(
          app,
          request.user.sub,
          request.user.email
        );

        return {
          sub: request.user.sub,
          email: request.user.email ?? undefined,
          tier: doc.tier,
          effectiveTier: request.limits.effectiveTier,
          subscriptionStatus: doc.subscriptionStatus,
          projectLimit: request.limits.projectLimit,
          activeProjectCount: request.limits.activeProjectCount,
          atLimit: request.limits.atLimit,
          overLimit: request.limits.overLimit,
          linkedProviders: doc.providers.map((p) => ({
            providerId: p.providerId,
            email: p.email,
            linkedAt: p.linkedAt.toISOString()
          })),
          proSettings: doc.proSettings,
          deletionPendingAt: doc.deletionPendingAt?.toISOString()
        };
      }
    );

    app.patch(
      "/me/pro-settings",
      {
        preHandler: [app.requireUser]
      },
      async (request, reply) => {
        if (!request.user) {
          throw new Error("pro-settings route reached without user");
        }

        const parsed = proSettingsSchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400).send({
            error: "INVALID_PAYLOAD",
            details: parsed.error.issues
          });
          return;
        }

        // Ensure the doc exists before updating so first-time users can
        // save Pro Settings even before their first project.
        await readOrCreateUserDoc(app, request.user.sub, request.user.email);

        await app.mongo.users.updateOne(
          { sub: request.user.sub },
          {
            $set: Object.fromEntries(
              Object.entries(parsed.data).map(([k, v]) => [
                `proSettings.${k}`,
                v
              ])
            )
          }
        );

        reply.code(204).send();
      }
    );
  },
  {
    name: "muralist-routes-me",
    fastify: "4.x",
    dependencies: ["muralist-mongo", "muralist-require-user"]
  }
);
