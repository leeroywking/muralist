import cors from "@fastify/cors";
import Fastify from "fastify";
import { loadPaintBrandCatalog } from "@muralist/config";
import {
  estimatePaintRequirement,
  getAuthCapabilities,
  type EstimateInput
} from "@muralist/core";

export async function buildServer() {
  const app = Fastify({
    logger: false
  });

  await app.register(cors, {
    origin: true
  });

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

