import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

const app = await buildServer();

try {
  await app.listen({ host, port });
  console.log(`muralist-api listening on http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

