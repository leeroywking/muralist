import { MongoClient } from "mongodb";
import { loadTierConfig, loadUploadLimits } from "@muralist/config";
import { createAuth, type OAuthCredentials } from "./auth.js";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

type RequiredEnv = {
  MONGO_URI: string;
  MONGO_DB_NAME: string;
  BETTER_AUTH_SECRET: string;
  APP_BASE_URL: string;
};

const REQUIRED_ENV_KEYS: Array<keyof RequiredEnv> = [
  "MONGO_URI",
  "MONGO_DB_NAME",
  "BETTER_AUTH_SECRET",
  "APP_BASE_URL"
];

function readRequiredEnv(): RequiredEnv {
  const missing: string[] = [];
  const values: Partial<RequiredEnv> = {};
  for (const key of REQUIRED_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw || raw.length === 0) {
      missing.push(key);
    } else {
      values[key] = raw;
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[muralist-api] Missing required environment variables: ${missing.join(
        ", "
      )}. See .env.example for the full list.`
    );
  }
  return values as RequiredEnv;
}

function readOAuth(prefix: string): OAuthCredentials | undefined {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

try {
  const env = readRequiredEnv();

  const mongoClient = new MongoClient(env.MONGO_URI);
  await mongoClient.connect();

  // WEB_ORIGIN is optional — falls back to APP_BASE_URL for single-origin
  // setups (e.g. local dev). In staging/prod the web app lives on a
  // different subdomain than the API and must be explicitly allowed.
  const webOrigin = process.env.WEB_ORIGIN || undefined;

  const { auth, enabledProviders, skippedProviders } = createAuth({
    client: mongoClient,
    dbName: env.MONGO_DB_NAME,
    secret: env.BETTER_AUTH_SECRET,
    appBaseURL: env.APP_BASE_URL,
    webOrigin,
    providers: {
      google: readOAuth("GOOGLE"),
      apple: readOAuth("APPLE"),
      facebook: readOAuth("FACEBOOK"),
      adobe: readOAuth("ADOBE")
    }
  });

  if (skippedProviders.length > 0) {
    console.warn(
      `[muralist-api] OAuth providers skipped (missing CLIENT_ID/SECRET): ${skippedProviders.join(
        ", "
      )}`
    );
  }
  console.log(
    `[muralist-api] OAuth providers enabled: ${
      enabledProviders.length > 0 ? enabledProviders.join(", ") : "(none)"
    }`
  );

  const [tierConfig, uploadLimits] = await Promise.all([
    loadTierConfig(),
    loadUploadLimits()
  ]);

  const app = await buildServer({
    appBaseURL: env.APP_BASE_URL,
    webOrigin,
    mongo: { uri: env.MONGO_URI, dbName: env.MONGO_DB_NAME },
    auth,
    tierConfig,
    uploadLimits
  });

  app.addHook("onClose", async () => {
    await mongoClient.close();
  });

  await app.listen({ host, port });
  console.log(`muralist-api listening on http://${host}:${port}`);
} catch (error) {
  console.error("[muralist-api] Startup failed:", error);
  process.exit(1);
}
