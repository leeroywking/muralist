import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import csrf from "@fastify/csrf-protection";
import Fastify, {
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { loadPaintBrandCatalog } from "@muralist/config";
import {
  estimatePaintRequirement,
  getAuthCapabilities,
  type EstimateInput
} from "@muralist/core";
import type { AuthInstance } from "./auth.js";
import { mongoPlugin, type MongoPluginOptions } from "./db.js";
import { requireUserPlugin } from "./plugins/requireUser.js";
import {
  tierEnforcementPlugin,
  TierLimitError
} from "./plugins/tierEnforcement.js";
import { meRoutes } from "./routes/me.js";
import { accountRoutes } from "./routes/account.js";
import { exportRoutes } from "./routes/export.js";
import { projectsRoutes, mapProjectsError } from "./routes/projects.js";
import type { TierConfig, UploadLimits } from "@muralist/config";

export type BuildServerOptions = {
  /**
   * Public base URL of the web app. Used as the sole CORS origin and echoed
   * to Better Auth as a trusted origin. Required — we do not fall back to
   * `origin: true`.
   */
  appBaseURL: string;
  /**
   * Mongo connection info. When omitted the Mongo plugin is not registered,
   * which is useful for targeted tests that inject a stub auth instance.
   */
  mongo?: MongoPluginOptions;
  /**
   * Pre-built Better Auth instance. Injected rather than constructed here so
   * the server can be tested against a stub (`{ handler }`) without spinning
   * up OAuth config.
   */
  auth?: AuthInstance;
  /**
   * Base path Better Auth is mounted on. Must match how `createAuth` was
   * called. Defaults to "/api/auth".
   */
  authBasePath?: string;
  /**
   * Tier limits loaded from `config/tiers.yaml`. When omitted, the tier
   * enforcement plugin is not registered, which is only safe for tests that
   * don't exercise gated routes.
   */
  tierConfig?: TierConfig;
  /**
   * Upload size/type caps loaded from `config/upload-limits.yaml`. Required
   * for the projects CRUD routes; when omitted those routes are not
   * registered.
   */
  uploadLimits?: UploadLimits;
};

async function toFetchRequest(
  request: FastifyRequest,
  appBaseURL: string
): Promise<Request> {
  const url = new URL(request.url, appBaseURL);

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? JSON.stringify(request.body ?? {}) : undefined;

  return new Request(url.toString(), { method, headers, body });
}

async function pipeFetchResponse(
  response: Response,
  reply: FastifyReply
): Promise<void> {
  reply.status(response.status);

  // Set-Cookie needs special handling. Fetch Headers comma-collapses on
  // default iteration, but cookie Expires values contain literal commas
  // (e.g. `Expires=Wed, 09 Jun 2024 …`), so a single comma-joined value
  // written once corrupts both cookies when Better Auth issues two
  // (session + CSRF) in the same response. `getSetCookie()` returns each
  // cookie as a separate entry; we forward them individually.
  const maybeGetSetCookie = (
    response.headers as unknown as {
      getSetCookie?: () => string[];
    }
  ).getSetCookie;
  if (typeof maybeGetSetCookie === "function") {
    for (const cookie of maybeGetSetCookie.call(response.headers)) {
      reply.header("set-cookie", cookie);
    }
  }

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return; // handled above
    reply.header(key, value);
  });

  const buf = Buffer.from(await response.arrayBuffer());
  await reply.send(buf);
}

export async function buildServer(opts: BuildServerOptions) {
  const app = Fastify({
    logger: false
  });

  // 1. Cookie parser — required before CSRF (which stores its token in a cookie)
  //    and before Better Auth (which reads/writes session cookies).
  await app.register(cookie);

  // 2. CSRF double-submit: cookie `csrf-token` (readable by JS), header
  //    `X-CSRF-Token` on mutating requests. Only applied to routes that opt
  //    into `preHandler: app.csrfProtection`; Better Auth's own endpoints run
  //    their own origin checks and are excluded.
  await app.register(csrf, {
    cookieKey: "csrf-token",
    cookieOpts: {
      path: "/",
      sameSite: "lax",
      secure: true,
      // Deliberately NOT httpOnly: the client must read the cookie to echo
      // it in the X-CSRF-Token header (double-submit pattern, per plan §3 C).
      httpOnly: false
    },
    getToken: (req: FastifyRequest) => {
      const headerValue = req.headers["x-csrf-token"];
      if (Array.isArray(headerValue)) return headerValue[0];
      return headerValue;
    }
  });

  // 3. CORS — scoped to APP_BASE_URL only. DELIBERATE CHANGE from the prior
  //    `origin: true`. Required by docs/SECURITY_REVIEW.md and plan step 20.
  await app.register(cors, {
    origin: opts.appBaseURL,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "If-Match"]
  });

  // 4. Mongo connection + collection bootstrap.
  if (opts.mongo) {
    await app.register(mongoPlugin, opts.mongo);
  }

  // 5. Better Auth handlers under /api/auth/*. We translate Fastify's
  //    req/reply to/from the Fetch API because Better Auth exposes a
  //    Web Fetch handler (`handler(request: Request) => Promise<Response>`).
  const basePath = opts.authBasePath ?? "/api/auth";
  if (opts.auth) {
    const authInstance = opts.auth;
    app.all(`${basePath}/*`, async (request, reply) => {
      const fetchRequest = await toFetchRequest(request, opts.appBaseURL);
      const fetchResponse = await authInstance.handler(fetchRequest);
      await pipeFetchResponse(fetchResponse, reply);
    });

    // requireUser depends on a real AuthInstance; register only when auth
    // is provided so stub-free tests can skip it.
    await app.register(requireUserPlugin, { auth: opts.auth });
  }

  // 6. Tier enforcement — depends on Mongo. Only register when both Mongo
  //    and tierConfig are present.
  if (opts.mongo && opts.tierConfig) {
    await app.register(tierEnforcementPlugin, { tierConfig: opts.tierConfig });
  }

  // 7. Centralised error mapping for domain errors like TierLimitError.
  //    Registered BEFORE product routes so every route inherits it.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TierLimitError) {
      reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    const mapped = mapProjectsError(error);
    if (mapped) {
      reply.code(mapped.statusCode).send(mapped.body);
      return;
    }
    reply.send(error);
  });

  // 8. Product routes — only wire when the prerequisites are present.
  if (opts.mongo && opts.auth && opts.tierConfig) {
    await app.register(meRoutes);
    await app.register(accountRoutes);
    await app.register(exportRoutes);
    if (opts.uploadLimits) {
      await app.register(projectsRoutes, { uploadLimits: opts.uploadLimits });
    }
  }

  // 6. Existing endpoints — unchanged contract.
  app.get("/health", async () => ({
    ok: true,
    service: "muralist-api"
  }));

  app.get("/api/auth/capabilities", async () => ({
    auth: getAuthCapabilities()
  }));

  app.get("/api/paint-brands", async () => {
    const catalog = await loadPaintBrandCatalog();
    return {
      version: catalog.version,
      units: catalog.units,
      brands: catalog.brands
    };
  });

  app.post<{ Body: EstimateInput }>("/api/estimate", async (request) => {
    const catalog = await loadPaintBrandCatalog();
    return estimatePaintRequirement(request.body, catalog);
  });

  return app;
}
