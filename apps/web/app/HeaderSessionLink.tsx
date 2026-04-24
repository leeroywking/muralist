"use client";

import { useEffect, useState } from "react";
import { UnauthenticatedError, getMe, type Me } from "./apiClient";

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; label: string };

function extractEmail(me: Me): string | null {
  const maybe = me as Me & { email?: unknown };
  return typeof maybe.email === "string" ? maybe.email : null;
}

/**
 * Tiny session indicator for the top-right of the site header. Shows
 * "Sign in" when logged out and "Signed in as <email>" (deeplinked to
 * `/signin`) when logged in. Intentionally dumb — no dropdown, no avatar;
 * those are follow-up UI work per docs/plans/web-ui-post-backend.md.
 */
export function HeaderSessionLink() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await getMe();
        if (cancelled) return;
        const email = extractEmail(me);
        setState({
          status: "signed-in",
          label: email ?? "your account"
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthenticatedError) {
          setState({ status: "signed-out" });
        } else {
          // Network blip: default to signed-out so the user can still click
          // into the sign-in page.
          setState({ status: "signed-out" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <span className="header-session-link header-session-loading" aria-hidden="true">
        &nbsp;
      </span>
    );
  }

  if (state.status === "signed-in") {
    return (
      <a className="header-session-link" href="/signin">
        Signed in as {state.label}
      </a>
    );
  }

  return (
    <a className="header-session-link" href="/signin">
      Sign in
    </a>
  );
}
