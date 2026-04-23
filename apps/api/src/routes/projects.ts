import fp from "fastify-plugin";
import {
  Binary,
  ObjectId,
  type ClientSession,
  type Filter
} from "mongodb";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { UploadLimits } from "@muralist/config";
import {
  createProjectSchema,
  updatePaletteSchema,
  updateImageSchema,
  updateThumbnailSchema,
  updateMetadataSchema
} from "../schemas/project.js";
import {
  validateImagePayload,
  type ImageErrorCode
} from "../imageValidation.js";
import type { ProjectDoc, ThumbnailDoc } from "../types.js";

const TRASH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type ProjectsRoutesOptions = {
  uploadLimits: UploadLimits;
};

/**
 * Domain error surfaced as HTTP 404. Thrown when a project is missing or the
 * caller is not its owner (we do not leak the existence/non-existence
 * distinction across users).
 */
export class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";
  constructor(message = "Project not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Domain error surfaced as HTTP 410. Used for trashed projects the caller did
 * not opt into viewing, and for restore attempts past the grace window.
 */
export class GoneError extends Error {
  readonly statusCode = 410;
  readonly code: string;
  constructor(code: string, message = "Resource gone") {
    super(message);
    this.name = "GoneError";
    this.code = code;
  }
}

/**
 * Domain error surfaced as HTTP 428. Thrown when a version-conditional write
 * is attempted without an `If-Match` header.
 */
export class PreconditionRequiredError extends Error {
  readonly statusCode = 428;
  readonly code = "PRECONDITION_REQUIRED";
  constructor(message = "If-Match header required") {
    super(message);
    this.name = "PreconditionRequiredError";
  }
}

/**
 * Domain error surfaced as HTTP 409. Thrown when `If-Match` carries a stale
 * version number.
 */
export class VersionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "VERSION_CONFLICT";
  constructor(message = "Version mismatch") {
    super(message);
    this.name = "VersionConflictError";
  }
}

/**
 * Domain error surfaced as HTTP 400 with the specific ImageErrorCode in the
 * body. Thrown when pass-through image validation fails.
 */
export class ImageValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "IMAGE_VALIDATION_FAILED";
  readonly reason: ImageErrorCode;
  constructor(reason: ImageErrorCode) {
    super(`Image validation failed: ${reason}`);
    this.name = "ImageValidationError";
    this.reason = reason;
  }
}

function toObjectId(raw: string): ObjectId | null {
  if (!ObjectId.isValid(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

function binaryToBase64(bin: Binary | undefined): string {
  if (!bin) return "";
  // Binary.toString('base64') works across mongodb driver versions.
  return bin.toString("base64");
}

function parseIfMatch(header: string | string[] | undefined): number | null {
  if (Array.isArray(header)) header = header[0];
  if (!header) return null;
  // Accept both bare numbers and RFC 7232 weak/strong quoted forms.
  const stripped = header.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const n = Number(stripped);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

async function loadOwnedProject(
  app: FastifyInstance,
  userSub: string,
  projectId: string
): Promise<ProjectDoc & { _id: ObjectId }> {
  const oid = toObjectId(projectId);
  if (!oid) throw new NotFoundError();
  const filter: Filter<ProjectDoc> = { _id: oid, userId: userSub };
  const doc = await app.mongo.projects.findOne(filter);
  if (!doc) throw new NotFoundError();
  // Mongo always returns a populated `_id` on findOne results; narrow the
  // optional to required for callers.
  return doc as ProjectDoc & { _id: ObjectId };
}

/**
 * Projects CRUD routes plugin. Register AFTER mongo, requireUser, and
 * tierEnforcement plugins; the plugin asserts `app.requireUser`, `app.mongo`,
 * `app.computeLimits`, and `app.assertWriteAllowed` are present.
 */
export const projectsRoutes = fp<ProjectsRoutesOptions>(
  async (app, opts) => {
    const { uploadLimits } = opts;

    const requireUser = app.requireUser;
    const computeLimits = app.computeLimits;
    const csrfProtection = app.csrfProtection;

    // Read-only preHandler: auth only, no CSRF needed (safe methods).
    const preAuth = {
      preHandler: requireUser
    };

    const withLimits = async (req: FastifyRequest) => {
      await computeLimits(req);
    };
    // Mutating preHandler: auth first so unauthenticated requests still get
    // 401 (not 403), then CSRF double-submit check. `preMutateWithLimits`
    // additionally runs the tier-limit computation so handlers can call
    // `app.assertWriteAllowed(request)`.
    const preMutate = { preHandler: [requireUser, csrfProtection] };
    const preMutateWithLimits = {
      preHandler: [requireUser, csrfProtection, withLimits]
    };

    // POST /projects — requires user + limits, applies one-grace-save.
    app.post<{ Body: unknown }>(
      "/projects",
      preMutateWithLimits,
      async (request, reply) => {
        const parsed = createProjectSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "SCHEMA_VALIDATION_FAILED", issues: parsed.error.issues });
        }
        const body = parsed.data;

        const imageResult = validateImagePayload(
          body.image,
          "sanitizedImage",
          uploadLimits
        );
        if (!imageResult.ok) {
          throw new ImageValidationError(imageResult.reason);
        }
        const thumbResult = validateImagePayload(
          body.thumbnail,
          "thumbnail",
          uploadLimits
        );
        if (!thumbResult.ok) {
          throw new ImageValidationError(thumbResult.reason);
        }

        // One-grace-save: allow when activeProjectCount === projectLimit.
        // Only reject when strictly over limit. `assertWriteAllowed` already
        // encodes this (overLimit only), so use it directly.
        app.assertWriteAllowed(request);

        const now = new Date();
        const userId = request.user!.sub;
        const projectOid = new ObjectId();
        const thumbOid = new ObjectId();

        const projectDoc: ProjectDoc & { _id: ObjectId } = {
          _id: projectOid,
          userId,
          name: body.name,
          palette: body.palette,
          sanitizedImage: new Binary(imageResult.bytes),
          metadata: body.metadata ?? {},
          version: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
          lastViewedAt: now
        };

        const thumbDoc: ThumbnailDoc & { _id: ObjectId } = {
          _id: thumbOid,
          projectId: projectOid.toHexString(),
          userId,
          thumbnail: new Binary(thumbResult.bytes),
          name: body.name,
          lastViewedAt: now,
          status: "active"
        };

        const client = app.mongo.client;
        await client.withSession(async (session: ClientSession) => {
          await session.withTransaction(async () => {
            await app.mongo.projects.insertOne(projectDoc as ProjectDoc, {
              session
            });
            await app.mongo.thumbnails.insertOne(thumbDoc as ThumbnailDoc, {
              session
            });
          });
        });

        return reply.code(201).send({
          id: projectOid.toHexString(),
          name: projectDoc.name,
          status: projectDoc.status,
          version: projectDoc.version,
          createdAt: projectDoc.createdAt.toISOString(),
          updatedAt: projectDoc.updatedAt.toISOString(),
          lastViewedAt: projectDoc.lastViewedAt.toISOString()
        });
      }
    );

    // GET /projects — tile listing from thumbnails collection.
    app.get<{ Querystring: { status?: string } }>(
      "/projects",
      preAuth,
      async (request, reply) => {
        const rawStatus = request.query?.status;
        const status =
          rawStatus === "trashed" ? "trashed" : "active"; // default active
        const userId = request.user!.sub;

        const rows = await app.mongo.thumbnails
          .find(
            { userId, status },
            {
              projection: {
                _id: 1,
                projectId: 1,
                name: 1,
                thumbnail: 1,
                lastViewedAt: 1,
                status: 1
              }
            }
          )
          .toArray();

        const projects = rows.map((row) => ({
          id: row.projectId,
          name: row.name,
          status: row.status,
          lastViewedAt:
            row.lastViewedAt instanceof Date
              ? row.lastViewedAt.toISOString()
              : row.lastViewedAt,
          thumbnail: binaryToBase64(row.thumbnail)
        }));

        return reply.send({ projects });
      }
    );

    // GET /projects/:id — full project doc.
    app.get<{
      Params: { id: string };
      Querystring: { includeTrashed?: string };
    }>("/projects/:id", preAuth, async (request, reply) => {
      const userId = request.user!.sub;
      const doc = await loadOwnedProject(app, userId, request.params.id);

      const includeTrashed = request.query?.includeTrashed === "true";
      if (doc.status === "trashed" && !includeTrashed) {
        throw new GoneError("TRASHED");
      }

      const now = new Date();
      // Touch lastViewedAt on both collections — no version bump.
      await app.mongo.projects.updateOne(
        { _id: doc._id } as Filter<ProjectDoc>,
        { $set: { lastViewedAt: now } }
      );
      await app.mongo.thumbnails.updateOne(
        { projectId: doc._id.toHexString(), userId },
        { $set: { lastViewedAt: now } }
      );

      return reply.send({
        id: doc._id.toHexString(),
        name: doc.name,
        palette: doc.palette,
        metadata: doc.metadata,
        version: doc.version,
        status: doc.status,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        lastViewedAt: now,
        deletedAt: doc.deletedAt,
        sanitizedImage: binaryToBase64(doc.sanitizedImage)
      });
    });

    // PATCH /projects/:id/palette — version-conditional write.
    app.patch<{ Params: { id: string }; Body: unknown }>(
      "/projects/:id/palette",
      preMutateWithLimits,
      async (request, reply) => {
        const ifMatch = parseIfMatch(request.headers["if-match"]);
        if (ifMatch === null) throw new PreconditionRequiredError();

        const parsed = updatePaletteSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "SCHEMA_VALIDATION_FAILED", issues: parsed.error.issues });
        }

        app.assertWriteAllowed(request);

        const doc = await loadOwnedProject(
          app,
          request.user!.sub,
          request.params.id
        );
        if (doc.status === "trashed") throw new GoneError("TRASHED");
        if (doc.version !== ifMatch) throw new VersionConflictError();

        const now = new Date();
        const nextVersion = doc.version + 1;
        await app.mongo.projects.updateOne(
          { _id: doc._id, version: doc.version } as Filter<ProjectDoc>,
          {
            $set: {
              palette: parsed.data.palette,
              updatedAt: now,
              version: nextVersion
            }
          }
        );

        return reply.send({
          id: doc._id.toHexString(),
          version: nextVersion,
          updatedAt: now.toISOString()
        });
      }
    );

    // PATCH /projects/:id/image — pass-through validation, bumps version.
    app.patch<{ Params: { id: string }; Body: unknown }>(
      "/projects/:id/image",
      preMutateWithLimits,
      async (request, reply) => {
        const parsed = updateImageSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "SCHEMA_VALIDATION_FAILED", issues: parsed.error.issues });
        }

        app.assertWriteAllowed(request);

        const result = validateImagePayload(
          parsed.data.image,
          "sanitizedImage",
          uploadLimits
        );
        if (!result.ok) throw new ImageValidationError(result.reason);

        const doc = await loadOwnedProject(
          app,
          request.user!.sub,
          request.params.id
        );
        if (doc.status === "trashed") throw new GoneError("TRASHED");

        const now = new Date();
        const nextVersion = doc.version + 1;
        await app.mongo.projects.updateOne(
          { _id: doc._id } as Filter<ProjectDoc>,
          {
            $set: {
              sanitizedImage: new Binary(result.bytes),
              updatedAt: now,
              version: nextVersion
            }
          }
        );

        return reply.send({
          id: doc._id.toHexString(),
          version: nextVersion,
          updatedAt: now.toISOString()
        });
      }
    );

    // PATCH /projects/:id/thumbnail — writes to thumbnail collection and bumps
    // version on the projects doc so the client can use a single versioning
    // axis across artifacts.
    app.patch<{ Params: { id: string }; Body: unknown }>(
      "/projects/:id/thumbnail",
      preMutateWithLimits,
      async (request, reply) => {
        const parsed = updateThumbnailSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "SCHEMA_VALIDATION_FAILED", issues: parsed.error.issues });
        }

        app.assertWriteAllowed(request);

        const result = validateImagePayload(
          parsed.data.thumbnail,
          "thumbnail",
          uploadLimits
        );
        if (!result.ok) throw new ImageValidationError(result.reason);

        const doc = await loadOwnedProject(
          app,
          request.user!.sub,
          request.params.id
        );
        if (doc.status === "trashed") throw new GoneError("TRASHED");

        const now = new Date();
        const nextVersion = doc.version + 1;

        await app.mongo.thumbnails.updateOne(
          { projectId: doc._id.toHexString(), userId: request.user!.sub },
          { $set: { thumbnail: new Binary(result.bytes) } }
        );
        await app.mongo.projects.updateOne(
          { _id: doc._id } as Filter<ProjectDoc>,
          { $set: { updatedAt: now, version: nextVersion } }
        );

        return reply.send({
          id: doc._id.toHexString(),
          version: nextVersion,
          updatedAt: now.toISOString()
        });
      }
    );

    // PATCH /projects/:id/metadata — name + metadata edits; mirror name to
    // thumbnail collection so dashboard tiles stay consistent.
    app.patch<{ Params: { id: string }; Body: unknown }>(
      "/projects/:id/metadata",
      preMutateWithLimits,
      async (request, reply) => {
        const parsed = updateMetadataSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "SCHEMA_VALIDATION_FAILED", issues: parsed.error.issues });
        }

        app.assertWriteAllowed(request);

        const doc = await loadOwnedProject(
          app,
          request.user!.sub,
          request.params.id
        );
        if (doc.status === "trashed") throw new GoneError("TRASHED");

        const now = new Date();
        const nextVersion = doc.version + 1;

        const set: Record<string, unknown> = {
          updatedAt: now,
          version: nextVersion
        };
        if (parsed.data.name !== undefined) set.name = parsed.data.name;
        if (parsed.data.metadata !== undefined) set.metadata = parsed.data.metadata;

        await app.mongo.projects.updateOne(
          { _id: doc._id } as Filter<ProjectDoc>,
          { $set: set }
        );

        if (parsed.data.name !== undefined) {
          await app.mongo.thumbnails.updateOne(
            { projectId: doc._id.toHexString(), userId: request.user!.sub },
            { $set: { name: parsed.data.name } }
          );
        }

        return reply.send({
          id: doc._id.toHexString(),
          version: nextVersion,
          updatedAt: now.toISOString()
        });
      }
    );

    // DELETE /projects/:id — escape valve: allowed even in read-only mode.
    app.delete<{ Params: { id: string } }>(
      "/projects/:id",
      preMutateWithLimits,
      async (request, reply) => {
        app.assertWriteAllowed(request, { allowInReadOnly: true });

        const doc = await loadOwnedProject(
          app,
          request.user!.sub,
          request.params.id
        );
        if (doc.status === "trashed") {
          return reply.send({
            id: doc._id.toHexString(),
            status: "trashed"
          });
        }

        const now = new Date();
        await app.mongo.projects.updateOne(
          { _id: doc._id } as Filter<ProjectDoc>,
          { $set: { status: "trashed", deletedAt: now, updatedAt: now } }
        );
        await app.mongo.thumbnails.updateOne(
          { projectId: doc._id.toHexString(), userId: request.user!.sub },
          { $set: { status: "trashed", deletedAt: now } }
        );

        return reply.send({
          id: doc._id.toHexString(),
          status: "trashed",
          deletedAt: now.toISOString()
        });
      }
    );

    // POST /projects/:id/restore — only within 14-day grace window. Restore
    // does NOT get one-grace-save; if restoring pushes the user over limit,
    // the restore still succeeds and the user enters read-only on subsequent
    // writes.
    app.post<{ Params: { id: string } }>(
      "/projects/:id/restore",
      preMutateWithLimits,
      async (request, reply) => {
        const doc = await loadOwnedProject(
          app,
          request.user!.sub,
          request.params.id
        );
        if (doc.status !== "trashed") {
          throw new GoneError("NOT_TRASHED", "Project is not trashed");
        }

        if (doc.deletedAt) {
          const elapsed = Date.now() - new Date(doc.deletedAt).getTime();
          if (elapsed >= TRASH_WINDOW_MS) {
            throw new GoneError(
              "GRACE_EXPIRED",
              "Project is past the 14-day recovery window"
            );
          }
        }

        const now = new Date();
        await app.mongo.projects.updateOne(
          { _id: doc._id } as Filter<ProjectDoc>,
          {
            $set: { status: "active", updatedAt: now },
            $unset: { deletedAt: "" }
          }
        );
        await app.mongo.thumbnails.updateOne(
          { projectId: doc._id.toHexString(), userId: request.user!.sub },
          {
            $set: { status: "active" },
            $unset: { deletedAt: "" }
          }
        );

        return reply.send({
          id: doc._id.toHexString(),
          status: "active",
          restoredAt: now.toISOString()
        });
      }
    );

    // POST /projects/:id/viewed — touches lastViewedAt only. No version bump.
    app.post<{ Params: { id: string } }>(
      "/projects/:id/viewed",
      preMutate,
      async (request, reply) => {
        const doc = await loadOwnedProject(
          app,
          request.user!.sub,
          request.params.id
        );

        const now = new Date();
        await app.mongo.projects.updateOne(
          { _id: doc._id } as Filter<ProjectDoc>,
          { $set: { lastViewedAt: now } }
        );
        await app.mongo.thumbnails.updateOne(
          { projectId: doc._id.toHexString(), userId: request.user!.sub },
          { $set: { lastViewedAt: now } }
        );

        return reply.send({
          id: doc._id.toHexString(),
          lastViewedAt: now.toISOString()
        });
      }
    );
  },
  {
    name: "muralist-projects-routes",
    fastify: "4.x",
    dependencies: ["muralist-mongo", "muralist-require-user", "muralist-tier-enforcement"]
  }
);

/**
 * Helper for the server's error handler — maps domain errors to
 * `{ statusCode, body }` tuples.
 */
export function mapProjectsError(
  error: unknown
): { statusCode: number; body: Record<string, unknown> } | null {
  if (error instanceof NotFoundError) {
    return { statusCode: 404, body: { error: error.code } };
  }
  if (error instanceof GoneError) {
    return { statusCode: 410, body: { error: error.code } };
  }
  if (error instanceof PreconditionRequiredError) {
    return { statusCode: 428, body: { error: error.code } };
  }
  if (error instanceof VersionConflictError) {
    return { statusCode: 409, body: { error: error.code } };
  }
  if (error instanceof ImageValidationError) {
    return {
      statusCode: 400,
      body: { error: error.code, reason: error.reason }
    };
  }
  return null;
}

// Re-export `FastifyReply` to quiet the "declared but never used" sanity
// check in environments where the import is only referenced inside the body.
export type { FastifyReply };
