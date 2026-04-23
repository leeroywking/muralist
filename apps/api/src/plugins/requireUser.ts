import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthInstance } from "../auth.js";

export type SessionUser = {
  sub: string;
  email?: string | null;
  sessionId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
  interface FastifyInstance {
    /**
     * Fastify `preHandler` that resolves the current Better Auth session.
     * Attaches `request.user` on success; sends 401 and ends the request on
     * failure. Route handlers gated by this decorator can assume
     * `request.user` is defined.
     */
    requireUser: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

export type RequireUserPluginOptions = {
  auth: AuthInstance;
};

function toFetchHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}

export const requireUserPlugin = fp<RequireUserPluginOptions>(
  async (app, opts) => {
    const { auth } = opts;

    app.decorate(
      "requireUser",
      async function requireUser(
        request: FastifyRequest,
        reply: FastifyReply
      ) {
        const session = await auth.api.getSession({
          headers: toFetchHeaders(request)
        });

        if (!session) {
          reply.code(401).send({ error: "UNAUTHENTICATED" });
          return;
        }

        request.user = {
          sub: session.user.id,
          email: session.user.email ?? null,
          sessionId: session.session.id
        };
      }
    );
  },
  {
    name: "muralist-require-user",
    fastify: "4.x",
    dependencies: []
  }
);
