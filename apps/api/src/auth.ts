import {
  betterAuth,
  type BetterAuthOptions,
  type BetterAuthPlugin
} from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { genericOAuth } from "better-auth/plugins";
import type { MongoClient } from "mongodb";

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

export type CreateAuthOptions = {
  client: MongoClient;
  dbName: string;
  secret: string;
  appBaseURL: string;
  /**
   * Web client origin. Added to Better Auth's trustedOrigins so sign-in
   * POSTs from a different subdomain than the API are accepted. Omitted
   * in local/test single-origin setups.
   */
  webOrigin?: string;
  /**
   * Base path Better Auth is mounted on. Defaults to "/api/auth".
   * Keep in sync with how the server mounts the handler.
   */
  basePath?: string;
  providers: {
    google?: OAuthCredentials;
    apple?: OAuthCredentials;
    facebook?: OAuthCredentials;
    adobe?: OAuthCredentials;
  };
};

/**
 * Minimal shape of a Better Auth instance the Fastify server needs. We keep
 * this narrow so tests can inject a stub without reconstructing the entire
 * `Auth` generic type graph. Includes the Fetch-style `handler` plus
 * `api.getSession`, which `requireUser` uses to resolve the current session
 * without round-tripping through the wildcard route.
 */
export type AuthInstance = {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (opts: {
      headers: Headers;
    }) => Promise<AuthSession | null>;
  };
};

export type AuthSession = {
  user: {
    id: string;
    email?: string | null;
    emailVerified?: boolean;
    name?: string | null;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date | string;
  };
};

export type CreateAuthResult = {
  auth: AuthInstance;
  enabledProviders: string[];
  skippedProviders: string[];
};

const ADOBE_IMS_DISCOVERY_URL =
  "https://ims-na1.adobelogin.com/ims/.well-known/openid-configuration";

/**
 * Build a configured Better Auth instance backed by the caller's MongoClient.
 *
 * Session cookies are HttpOnly + Secure + SameSite=Lax. Accounts auto-link on
 * matching verified email via the built-in `account.accountLinking` config.
 * Adobe is wired through the `genericOAuth` plugin against Adobe IMS's OIDC
 * discovery document; Google / Apple / Facebook use Better Auth's built-in
 * social providers. A provider is skipped silently if its env credentials are
 * missing; the caller decides how to log the skip list.
 */
export function createAuth(opts: CreateAuthOptions): CreateAuthResult {
  const {
    client,
    dbName,
    secret,
    appBaseURL,
    webOrigin,
    basePath = "/api/auth",
    providers
  } = opts;

  const enabledProviders: string[] = [];
  const skippedProviders: string[] = [];

  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};

  if (providers.google) {
    socialProviders.google = {
      clientId: providers.google.clientId,
      clientSecret: providers.google.clientSecret
    };
    enabledProviders.push("google");
  } else {
    skippedProviders.push("google");
  }

  if (providers.apple) {
    socialProviders.apple = {
      clientId: providers.apple.clientId,
      clientSecret: providers.apple.clientSecret
    };
    enabledProviders.push("apple");
  } else {
    skippedProviders.push("apple");
  }

  if (providers.facebook) {
    socialProviders.facebook = {
      clientId: providers.facebook.clientId,
      clientSecret: providers.facebook.clientSecret
    };
    enabledProviders.push("facebook");
  } else {
    skippedProviders.push("facebook");
  }

  const plugins: BetterAuthPlugin[] = [];

  if (providers.adobe) {
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: "adobe",
            clientId: providers.adobe.clientId,
            clientSecret: providers.adobe.clientSecret,
            discoveryUrl: ADOBE_IMS_DISCOVERY_URL,
            pkce: true,
            scopes: ["openid", "email", "profile"]
          }
        ]
      })
    );
    enabledProviders.push("adobe");
  } else {
    skippedProviders.push("adobe");
  }

  const db = client.db(dbName);

  const authOptions: BetterAuthOptions = {
    secret,
    baseURL: appBaseURL,
    basePath,
    trustedOrigins: Array.from(
      new Set([appBaseURL, webOrigin].filter((x): x is string => Boolean(x)))
    ),
    database: mongodbAdapter(db, { client }),
    socialProviders,
    account: {
      accountLinking: {
        enabled: true,
        // Link any trusted social provider automatically on matching email.
        trustedProviders: ["google", "apple", "facebook", "adobe"]
      }
    },
    advanced: {
      // Force HttpOnly + Secure + SameSite=Lax on every Better-Auth-issued
      // cookie. `useSecureCookies: true` holds even in dev so the config is
      // consistent across environments — the prototype runs behind Cloudflare
      // which terminates TLS, so Secure is safe in staging.
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/"
      }
    },
    plugins
  };

  const auth = betterAuth(authOptions);

  return { auth, enabledProviders, skippedProviders };
}
