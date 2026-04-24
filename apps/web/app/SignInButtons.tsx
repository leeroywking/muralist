"use client";

import { useEffect, useState } from "react";
import {
  UnauthenticatedError,
  getMe,
  signInSocial,
  signOut,
  type Me,
  type SocialProvider
} from "./apiClient";

// Providers live-wired in the backend today. Keep in sync with
// `packages/core`'s `getAuthCapabilities()` once that plumbing is finalised.
// Anything non-live renders as a greyed button for visual parity.
const PROVIDERS: ReadonlyArray<{
  id: SocialProvider;
  label: string;
  live: boolean;
  reason?: string;
}> = [
  { id: "google", label: "Sign in with Google", live: true },
  {
    id: "apple",
    label: "Sign in with Apple",
    live: false,
    reason: "Apple credentials not yet configured."
  },
  {
    id: "facebook",
    label: "Sign in with Facebook",
    live: false,
    reason: "Facebook credentials not yet configured."
  },
  {
    id: "adobe",
    label: "Sign in with Adobe",
    live: false,
    reason: "Adobe credentials not yet configured."
  }
];

type MeState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; me: Me; email: string | null };

// Better Auth's `/me` response shape in this repo (see apiClient's `Me`) does
// not currently include `email`. The backend stores it but hasn't surfaced it
// through the product `/me` endpoint. Fall back to a generic label when the
// field is absent so the UI still works.
function extractEmail(me: Me): string | null {
  const maybe = me as Me & { email?: unknown };
  return typeof maybe.email === "string" ? maybe.email : null;
}

export function SignInButtons() {
  const [meState, setMeState] = useState<MeState>({ status: "loading" });
  const [pendingProvider, setPendingProvider] = useState<SocialProvider | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await getMe();
        if (cancelled) return;
        setMeState({ status: "signed-in", me, email: extractEmail(me) });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthenticatedError) {
          setMeState({ status: "signed-out" });
          return;
        }
        // Network / unexpected error — treat as signed-out so the user can
        // try again. Surface a small error but keep the provider buttons
        // clickable.
        setMeState({ status: "signed-out" });
        setError(
          err instanceof Error
            ? `Couldn't check session: ${err.message}`
            : "Couldn't check session."
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignIn(provider: SocialProvider) {
    setError(null);
    setPendingProvider(provider);
    try {
      const response = await signInSocial({
        provider,
        callbackURL: "https://muraliste.com/"
      });
      if (!response?.url) {
        throw new Error("Sign-in response did not include a redirect URL.");
      }
      window.location.assign(response.url);
    } catch (err) {
      setPendingProvider(null);
      const message =
        err instanceof Error ? err.message : "Unknown error.";
      setError(
        `Couldn't start ${capitalise(provider)} sign-in: ${message}`
      );
    }
  }

  async function handleSignOut() {
    setError(null);
    try {
      await signOut();
    } catch (err) {
      // If sign-out fails server-side, still bounce the user back to the
      // sign-in page — clearing the UI is better than a stuck state.
      // Surface the error so we notice.
      // eslint-disable-next-line no-console
      console.warn("sign-out failed", err);
    }
    window.location.assign("/signin");
  }

  if (meState.status === "loading") {
    return (
      <section className="signin-panel">
        <p className="signin-loading">Checking session…</p>
      </section>
    );
  }

  if (meState.status === "signed-in") {
    const label = meState.email ?? "your account";
    return (
      <section className="signin-panel">
        <h2 className="signin-heading">You're signed in</h2>
        <p className="signin-identity">
          Signed in as <strong>{label}</strong>.
        </p>
        <div className="signin-actions">
          <a className="signin-primary" href="/">
            Continue
          </a>
          <button
            className="signin-secondary"
            onClick={handleSignOut}
            type="button"
          >
            Sign out
          </button>
        </div>
        {error ? (
          <p className="signin-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="signin-panel">
      <h2 className="signin-heading">Sign in</h2>
      <p className="signin-lede">
        Muralist uses social sign-in so you don't have to manage another
        password.
      </p>
      <div className="signin-providers">
        {PROVIDERS.map((provider) => {
          const isPending = pendingProvider === provider.id;
          const disabled = !provider.live || pendingProvider !== null;
          return (
            <button
              key={provider.id}
              className={`signin-provider signin-provider-${provider.id}`}
              disabled={disabled}
              onClick={() => (provider.live ? handleSignIn(provider.id) : undefined)}
              title={provider.live ? undefined : provider.reason}
              type="button"
            >
              {isPending ? "Connecting…" : provider.label}
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="signin-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function capitalise(value: string): string {
  if (value.length === 0) return value;
  return value[0]!.toUpperCase() + value.slice(1);
}
