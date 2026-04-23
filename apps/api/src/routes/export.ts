import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProjectDoc, ThumbnailDoc } from "../types.js";

const EXPORT_SCHEMA_VERSION = 1;

export const exportRoutes = fp(
  async (app: FastifyInstance) => {
    app.get(
      "/export",
      { preHandler: [app.requireUser] },
      async (request: FastifyRequest, reply) => {
        if (!request.user) {
          throw new Error("/export reached without user");
        }

        const userId = request.user.sub;
        const [projects, thumbnails] = await Promise.all([
          app.mongo.projects.find({ userId }).toArray(),
          app.mongo.thumbnails.find({ userId }).toArray()
        ]);

        const thumbnailByProjectId = new Map(
          thumbnails.map((t: ThumbnailDoc) => [t.projectId, t])
        );

        const payload = {
          schemaVersion: EXPORT_SCHEMA_VERSION,
          exportedAt: new Date().toISOString(),
          userId,
          projects: projects.map((p: ProjectDoc) => {
            const projectId = String(p._id);
            const thumb = thumbnailByProjectId.get(projectId);
            return {
              id: projectId,
              name: p.name,
              status: p.status,
              version: p.version,
              palette: p.palette,
              metadata: p.metadata,
              createdAt: p.createdAt.toISOString(),
              updatedAt: p.updatedAt.toISOString(),
              lastViewedAt: p.lastViewedAt.toISOString(),
              deletedAt: p.deletedAt?.toISOString(),
              sanitizedImage: p.sanitizedImage
                ? Buffer.from(p.sanitizedImage.buffer).toString("base64")
                : null,
              thumbnail: thumb?.thumbnail
                ? Buffer.from(thumb.thumbnail.buffer).toString("base64")
                : null
            };
          })
        };

        reply
          .header("content-type", "application/json; charset=utf-8")
          .header(
            "content-disposition",
            `attachment; filename="muralist-export-${userId}.json"`
          );

        // TODO: stream this response. Today the full payload (including
        // base64-encoded sanitized images + thumbnails for every project) is
        // assembled in memory and serialized by Fastify in one pass. Safe at
        // free tier (3 projects × ~25KB image + ~8KB thumb ≈ 100KB) but grows
        // linearly with the paid tier's project cap. Convert to
        // `reply.raw.write(chunk)` with a JSON streamer when that matters.
        return payload;
      }
    );
  },
  {
    name: "muralist-routes-export",
    fastify: "4.x",
    dependencies: ["muralist-mongo", "muralist-require-user"]
  }
);
