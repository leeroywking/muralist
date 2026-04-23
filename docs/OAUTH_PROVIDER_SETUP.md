# OAuth Provider Setup — Handoff

How to wire each OAuth provider (Google, Apple, Facebook, Adobe) into the
Muralist API. Read this before clicking through a provider console; each one
has its own gotchas documented below.

## Current status (2026-04-23)

| Provider  | Status       | Notes |
|-----------|--------------|-------|
| Google    | **Live**     | Credentials in `.env` + App Platform; staging login works end-to-end. |
| Apple     | Not started  | Requires paid Apple Developer Program ($99/yr). Code config changes required on first wire — see Apple section. |
| Facebook  | Not started  | Requires Meta for Developers account (free). |
| Adobe     | Not started  | Requires Adobe Developer Console account (free tier OK). Wired via Better Auth's Generic OAuth plugin, not a built-in social provider. |

## How Better Auth's sign-in flow actually works

Provider sign-in is **not** a URL you can paste into a browser. The flow:

1. Client (web app) **POSTs** to
   `https://muralist-api-vbgh6.ondigitalocean.app/api/auth/sign-in/social`
   with body `{"provider": "google", "callbackURL": "<where-to-land-after-login>"}`.
2. Server responds with `{"url": "https://accounts.google.com/..."}` — the
   provider's authorize URL, pre-populated with our client ID + state +
   PKCE challenge + our callback.
3. Client navigates the browser to that `url`.
4. Provider prompts the user; on approval, provider redirects the browser to
   `https://muralist-api-vbgh6.ondigitalocean.app/api/auth/callback/<provider>`
   (or `/api/auth/oauth2/callback/adobe` for Adobe specifically).
5. Our callback exchanges the auth code for tokens, creates the session row
   in Mongo, sets the `better-auth.session_token` cookie (HttpOnly, Secure,
   SameSite=Lax), and redirects the browser to the client's `callbackURL`.

For testing from a browser without the web-app UI wired up yet, open DevTools
on any same-origin page and run:

```js
const r = await fetch('/api/auth/sign-in/social', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  credentials: 'include',
  body: JSON.stringify({ provider: 'google', callbackURL: '/api/auth/get-session' })
});
const { url } = await r.json();
window.location = url;
```

## Staging vs production redirect URIs

The staging URL is `https://muralist-api-vbgh6.ondigitalocean.app`. Every
provider's "authorized redirect URI" must match exactly. When a custom
domain lands behind Cloudflare (task #16), the redirect URIs change and all
four provider consoles must be updated. You can usually add both the
staging and production URIs in parallel, so the staging flow keeps working
through the cutover.

Redirect URIs Better Auth expects:

```
Google    https://muralist-api-vbgh6.ondigitalocean.app/api/auth/callback/google
Apple     https://muralist-api-vbgh6.ondigitalocean.app/api/auth/callback/apple
Facebook  https://muralist-api-vbgh6.ondigitalocean.app/api/auth/callback/facebook
Adobe     https://muralist-api-vbgh6.ondigitalocean.app/api/auth/oauth2/callback/adobe
```

## Flow for adding a provider

1. Complete the provider-specific console setup (sections below).
2. Paste the provider's `CLIENT_ID` + `CLIENT_SECRET` into `.env` on the
   matching keys (see `.env.example`). Do NOT commit — `.env` is gitignored.
3. Run the spec-injection + apply cycle that's used for every secret on
   this app. One-liner (replace values from .env at runtime, write to a
   home-dir temp file because doctl's snap sandbox can't read `/tmp`):

   ```bash
   python3 <<'PY'
   import re, os
   spec = open('/home/ein/projects/muralist/.do/app.yaml').read()
   env = open('/home/ein/projects/muralist/.env').read()
   def grab(k):
       try: return env.split(f'{k}=')[1].split('\n')[0]
       except IndexError: return None
   for key in ['MONGO_URI','BETTER_AUTH_SECRET',
               'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET',
               'APPLE_CLIENT_ID','APPLE_CLIENT_SECRET',
               'FACEBOOK_CLIENT_ID','FACEBOOK_CLIENT_SECRET',
               'ADOBE_CLIENT_ID','ADOBE_CLIENT_SECRET']:
       v = grab(key)
       if not v: continue
       pat = r'(- key: ' + re.escape(key) + r'\n\s+scope:\s+\S+\n\s+type:\s+SECRET)'
       spec = re.sub(pat, lambda m: m.group(1) + '\n        value: "' + v + '"', spec, count=1)
   out = os.path.expanduser('~/muralist-do-secrets.tmp.yaml')
   open(out, 'w').write(spec); os.chmod(out, 0o600)
   PY
   doctl apps update 9d86ef02-3b5c-4df4-a9cb-d8c8abbbc4ce --spec ~/muralist-do-secrets.tmp.yaml
   shred -u ~/muralist-do-secrets.tmp.yaml 2>/dev/null || rm ~/muralist-do-secrets.tmp.yaml
   ```

4. Wait ~2 min for the App Platform redeploy (watch via
   `doctl apps list-deployments 9d86ef02-3b5c-4df4-a9cb-d8c8abbbc4ce`).
5. Confirm the new provider shows up in the runtime logs:

   ```bash
   FULL_ID=$(doctl apps list-deployments 9d86ef02-... -o json | \
     python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
   doctl apps logs 9d86ef02-... --deployment $FULL_ID --type run | grep "OAuth providers"
   # Expected: `OAuth providers enabled: google, <new-provider>`
   ```

6. Smoke-test the sign-in POST (see the DevTools snippet above) and watch
   the network tab for the redirect to the provider's authorize page.

---

## Google (reference — already wired)

Documented here so the setup can be replicated for staging/prod cutovers or
a fresh project.

1. Google Cloud Console → <https://console.cloud.google.com/apis/credentials>
2. Create a project if none exists.
3. **APIs & Services → OAuth consent screen** — pick "External" user type
   (unless you have a Google Workspace), fill in app name, user support
   email, developer contact email. App domain can stay empty for now.
   Add scopes: `openid`, `email`, `profile`. Add yourself as a Test User
   while consent is in Testing mode.
4. **Credentials → Create Credentials → OAuth client ID → "Web application"**.
5. Authorized redirect URIs:
   `https://muralist-api-vbgh6.ondigitalocean.app/api/auth/callback/google`
6. Copy **Client ID** and **Client Secret** → `.env` as `GOOGLE_CLIENT_ID`
   and `GOOGLE_CLIENT_SECRET`.
7. Apply via the steps in "Flow for adding a provider" above.

**Gotcha:** while in Testing mode, only users you've added to the Test
Users list can sign in. Published (with verification) is required for the
general public.

## Facebook

1. Meta for Developers → <https://developers.facebook.com/apps>.
2. **Create App → "Consumer"** type (not "Business" — Consumer is simpler
   and appropriate for a B2C product like Muralist).
3. App name, contact email, no parent Business Account required.
4. Add the **"Facebook Login"** product to the app.
5. **Facebook Login → Settings → Valid OAuth Redirect URIs**:
   `https://muralist-api-vbgh6.ondigitalocean.app/api/auth/callback/facebook`
6. **App Settings → Basic**: copy **App ID** and **App Secret** →
   `.env` as `FACEBOOK_CLIENT_ID` and `FACEBOOK_CLIENT_SECRET`.
7. Apply via the standard flow.

**Gotchas:**
- Facebook apps start in **"Development mode"**. Only roles (Admins,
  Developers, Testers) can sign in until the app is switched to "Live".
  "Live" requires a published Privacy Policy URL under App Settings →
  Basic, and sometimes Meta review depending on requested permissions.
- Requested scopes: Better Auth's Facebook integration defaults to
  `email`, `public_profile`. Both are available in Standard Access and
  don't require review.
- If sign-in fails with "URL Blocked" in the Facebook error message,
  double-check the redirect URI matches exactly — including scheme and
  no trailing slash.

## Adobe

Adobe IMS goes through Better Auth's Generic OAuth plugin, not a built-in
social provider, so the config shape is different and the callback URL has
a different prefix (`/api/auth/oauth2/callback/adobe` — note the `oauth2`
segment).

1. Adobe Developer Console → <https://developer.adobe.com/console>.
2. **Create new project** (name it e.g. "Muralist Sign-in").
3. **Add API** → select **"Adobe Identity Management Service (IMS)"** →
   choose **"User Authentication (OAuth 2.0)"** as credential type.
4. Platform: **"Web App"**.
5. Default redirect URI:
   `https://muralist-api-vbgh6.ondigitalocean.app/api/auth/oauth2/callback/adobe`
6. Redirect URI pattern: same as above, escaped as needed by Adobe's UI.
7. Scopes: make sure **`openid`**, **`email`**, **`profile`** are enabled —
   the Better Auth generic OAuth config in `apps/api/src/auth.ts` requests
   all three.
8. Copy **Client ID** and **Client Secret** → `.env` as `ADOBE_CLIENT_ID`
   and `ADOBE_CLIENT_SECRET`.
9. Apply via the standard flow.

**Gotcha:** Adobe's `discoveryUrl` is hardcoded in `apps/api/src/auth.ts`
to `https://ims-na1.adobelogin.com/ims/.well-known/openid-configuration`.
That works for North America Adobe IDs. If you need EU/APAC IMS endpoints
(e.g. `ims-na2`, `ims-fra1`), edit the constant in `auth.ts`. Most
consumer use cases don't care.

## Apple — requires dev account + code change

This is the painful one. Skip it if you haven't already paid for Apple
Developer Program ($99/yr).

### Apple Developer Console setup

1. <https://developer.apple.com/account> → **Certificates, IDs & Profiles**.
2. **Identifiers → (+) → App IDs → App**. Identifier like
   `com.muralist.api`. Capabilities: enable **"Sign in with Apple"**.
3. **Identifiers → (+) → Services IDs**. Identifier like
   `com.muralist.signin` (must differ from the App ID). This is what
   Apple calls your "client_id" for web flows and is what Better Auth
   stores in `APPLE_CLIENT_ID`.
4. Configure the Services ID: check "Sign in with Apple", primary App ID
   = the App ID from step 2, Return URLs:
   `https://muralist-api-vbgh6.ondigitalocean.app/api/auth/callback/apple`
5. **Keys → (+) → New Key**. Enable "Sign in with Apple", associate it
   with the App ID. Download the `.p8` file **once** — you cannot
   re-download it. Record the **Key ID** (10-char) and your **Team ID**
   (visible at the top-right of the console).

### The config-shape problem

Apple does **not** give you a static `client_secret`. The OAuth spec
technically requires one, so Apple has you generate a **JWT signed with
your private key** — different on every request. Better Auth handles the
JWT generation but needs its inputs as a structured object, not a string:

```ts
apple: {
  clientId: process.env.APPLE_CLIENT_ID,       // the Services ID
  teamId: process.env.APPLE_TEAM_ID,           // 10 chars
  keyId: process.env.APPLE_KEY_ID,             // 10 chars
  privateKey: process.env.APPLE_PRIVATE_KEY    // contents of the .p8 file
}
```

`apps/api/src/auth.ts` currently configures Apple with the simple
`{ clientId, clientSecret }` shape alongside Google and Facebook. When you
add Apple credentials, this file must change:

- Split Apple out of the `socialProviders.apple` branch so it uses the
  4-field shape above.
- Add `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` to `.env.example`
  and `.do/app.yaml` as additional SECRET env vars. Drop `APPLE_CLIENT_SECRET`
  (it's not used in this shape; Apple generates it from the other three).
- For `APPLE_PRIVATE_KEY`: the value is the contents of the `.p8` file
  including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----`
  lines. Embed the newlines as `\n` in the env var, then replace them back
  to actual newlines when reading in `auth.ts`.

**Flag this back to the session when you start Apple** — it's a non-trivial
diff and the test harness will need a fixture update to cover the new config
shape.

### Apple-specific gotchas

- Apple's email handling: Apple returns the user's email **only on the
  first sign-in** across all services of a given client ID. Subsequent
  sign-ins omit the email. Better Auth's adapter stores the email in Mongo
  on first login; re-linking requires the user to revoke Sign in with Apple
  access in their Apple ID settings and sign in again.
- Apple also supports "hide my email" (relay addresses). These are real
  email addresses for delivery but are per-app. Treat them as normal
  emails.
- Apple rejects sign-ins from http://localhost in most configurations.
  Testing requires a real HTTPS domain; use the staging URL or a tunnel
  (ngrok, cloudflared) to a local dev server.

## When a custom domain replaces the staging URL

When Cloudflare (task #16) is set up and the API is reachable at a real
domain (e.g. `https://api.muralist.example`), every provider console needs
the new redirect URI added alongside the staging one. Do not remove the
staging URI immediately — keeping both lets you roll back or test the
staging deploy without breaking real users.

Order of operations for the cutover:
1. Add the new redirect URI on each provider.
2. Update `APP_BASE_URL` on the App Platform env and redeploy — Better
   Auth uses this as the canonical base for minted redirect URIs.
3. Verify a sign-in works against the new domain.
4. Update `apps/web/app/apiClient.ts`'s `NEXT_PUBLIC_API_BASE_URL` (or the
   equivalent env var at build time) so the web client targets the new
   API.
5. Once the old URI stops receiving real traffic, remove it from the
   provider consoles.

## Capabilities endpoint note

`GET /api/auth/capabilities` currently returns a hardcoded list
(`["google","apple","facebook"]`) from `packages/core`'s `getAuthCapabilities()`.
It does not reflect which providers actually have credentials wired, and it
does not include `adobe`. When a second provider lands, consider either:

- Updating `getAuthCapabilities()` to read the enabled list from the API
  startup log / an exposed config, or
- Deleting the endpoint in favor of clients introspecting via Better Auth's
  own discovery (each provider either returns an auth URL or a "not
  configured" error on POST).

Flag this when the web app consumes the capabilities list.
