"use client";

// Import React as a namespace so the classic JSX transform (used by the
// `tsx` loader in the test runner) resolves `React.createElement` at
// runtime. Next.js itself uses the automatic JSX transform at build so
// either shape works, but the node:test harness boots via `tsx` / esbuild,
// and esbuild falls back to the classic transform when tsconfig sets
// `jsx: "preserve"`.
import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  UnauthenticatedError,
  deleteProject,
  getMe,
  listProjects,
  restoreProject,
  type Me,
  type ProjectStatus,
  type ProjectTile
} from "./apiClient";

// ---------------------------------------------------------------------------
// Helpers — extracted so they can be unit-tested without a DOM / React
// renderer. The component itself is a thin wrapper over these.
// ---------------------------------------------------------------------------

/**
 * Render a timestamp as "2 days ago" / "just now" using `Intl.RelativeTimeFormat`.
 * Returns an empty string on unparseable input so the UI keeps going.
 */
export function formatRelativeTime(
  value: string | undefined,
  now: Date = new Date()
): string {
  if (!value) return "";
  const then = Date.parse(value);
  if (Number.isNaN(then)) return "";
  const diffMs = then - now.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const absSec = Math.abs(diffSec);

  if (typeof Intl === "undefined" || typeof Intl.RelativeTimeFormat !== "function") {
    // Very old environment — fall back to a naive English formatter so
    // the tile still has some label.
    if (absSec < 60) return "just now";
    if (absSec < 3600) return `${Math.round(absSec / 60)} minutes ago`;
    if (absSec < 86400) return `${Math.round(absSec / 3600)} hours ago`;
    return `${Math.round(absSec / 86400)} days ago`;
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absSec < 45) return rtf.format(diffSec, "second");
  if (absSec < 60 * 45) return rtf.format(Math.round(diffSec / 60), "minute");
  if (absSec < 3600 * 22) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (absSec < 86400 * 26) return rtf.format(Math.round(diffSec / 86400), "day");
  if (absSec < 86400 * 320)
    return rtf.format(Math.round(diffSec / (86400 * 30)), "month");
  return rtf.format(Math.round(diffSec / (86400 * 365)), "year");
}

export type DashboardApi = {
  getMe: typeof getMe;
  listProjects: typeof listProjects;
  deleteProject: typeof deleteProject;
  restoreProject: typeof restoreProject;
};

export type LoadDashboardOutcome =
  | { kind: "redirect"; url: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; me: Me; projects: ProjectTile[] };

/**
 * Pure fetch orchestration: call `/me`, then `/projects?status=...`. On 401,
 * returns a redirect outcome; on other errors, returns an error outcome.
 * Extracted so tests can drive the happy, empty, and 401 paths without
 * needing a DOM.
 */
export async function loadDashboardState(
  api: DashboardApi,
  status: ProjectStatus
): Promise<LoadDashboardOutcome> {
  try {
    const me = await api.getMe();
    const projects = await api.listProjects(status);
    return { kind: "ready", me, projects };
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return { kind: "redirect", url: "/signin?returnTo=/projects" };
    }
    const message =
      err instanceof Error ? err.message : "Couldn't load projects.";
    return { kind: "error", message };
  }
}

/**
 * Pure delete orchestration: calls `api.deleteProject(id)` and, on success,
 * reloads the dashboard for the given status. Returns either the fresh
 * state or an error message. Extracted so tests can drive the delete-then-
 * refresh sequence without a DOM.
 */
export async function runDeleteThenRefresh(
  api: DashboardApi,
  id: string,
  status: ProjectStatus
): Promise<LoadDashboardOutcome | { kind: "action-error"; message: string }> {
  try {
    await api.deleteProject(id);
  } catch (err) {
    return {
      kind: "action-error",
      message:
        err instanceof Error
          ? `Couldn't delete project: ${err.message}`
          : "Couldn't delete project."
    };
  }
  return loadDashboardState(api, status);
}

// Status derived from the `?status=trashed` query param. Parsing is done in
// the component itself so the page remains a pure Server Component shell.
function readStatusFromLocation(): ProjectStatus {
  if (typeof window === "undefined") return "active";
  const params = new URLSearchParams(window.location.search);
  return params.get("status") === "trashed" ? "trashed" : "active";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; me: Me; projects: ProjectTile[] };

export type ProjectsDashboardProps = {
  /** Test seam: override `apiClient` methods. */
  api?: DashboardApi;
  /** Test seam: override the location assign call. */
  assignLocation?: (url: string) => void;
  /** Test seam: override `window.confirm`. */
  confirmFn?: (message: string) => boolean;
  /** Test seam: initial status. */
  initialStatus?: ProjectStatus;
};

const DEFAULT_API: DashboardApi = {
  getMe,
  listProjects,
  deleteProject,
  restoreProject
};

export function ProjectsDashboard(props: ProjectsDashboardProps = {}) {
  const api = props.api ?? DEFAULT_API;
  const assignLocation = useMemo(
    () =>
      props.assignLocation ??
      ((url: string) => {
        if (typeof window !== "undefined") window.location.assign(url);
      }),
    [props.assignLocation]
  );
  const confirmFn = useMemo(
    () =>
      props.confirmFn ??
      ((message: string) =>
        typeof window !== "undefined" ? window.confirm(message) : false),
    [props.confirmFn]
  );

  const [status, setStatus] = useState<ProjectStatus>(
    props.initialStatus ?? "active"
  );
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);

  // Sync with the `?status=` URL on first mount (client-side only, since the
  // page is statically exported).
  useEffect(() => {
    if (props.initialStatus) return;
    setStatus(readStatusFromLocation());
  }, [props.initialStatus]);

  const refresh = useCallback(
    async (nextStatus: ProjectStatus): Promise<void> => {
      setActionError(null);
      const outcome = await loadDashboardState(api, nextStatus);
      if (outcome.kind === "redirect") {
        assignLocation(outcome.url);
        return;
      }
      if (outcome.kind === "error") {
        setState({ kind: "error", message: outcome.message });
        return;
      }
      setState(outcome);
    },
    [api, assignLocation]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const outcome = await loadDashboardState(api, status);
      if (cancelled) return;
      if (outcome.kind === "redirect") {
        assignLocation(outcome.url);
        return;
      }
      if (outcome.kind === "error") {
        setState({ kind: "error", message: outcome.message });
        return;
      }
      setState(outcome);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, assignLocation, status]);

  async function handleDelete(project: ProjectTile) {
    const ok = confirmFn(
      `Delete "${project.name}"? You can restore it from Trash within 14 days.`
    );
    if (!ok) return;
    setActionError(null);
    const outcome = await runDeleteThenRefresh(api, project.id, status);
    if (outcome.kind === "action-error") {
      setActionError(outcome.message);
      return;
    }
    if (outcome.kind === "redirect") {
      assignLocation(outcome.url);
      return;
    }
    if (outcome.kind === "error") {
      setState({ kind: "error", message: outcome.message });
      return;
    }
    setState(outcome);
  }

  async function handleRestore(project: ProjectTile) {
    setActionError(null);
    try {
      await api.restoreProject(project.id);
      await refresh(status);
    } catch (err) {
      setActionError(
        err instanceof Error
          ? `Couldn't restore project: ${err.message}`
          : "Couldn't restore project."
      );
    }
  }

  function handleStatusToggle(next: ProjectStatus) {
    if (next === status) return;
    setStatus(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next === "trashed") url.searchParams.set("status", "trashed");
      else url.searchParams.delete("status");
      window.history.replaceState(null, "", url.toString());
    }
  }

  if (state.kind === "loading") {
    return (
      <section className="projects-panel" aria-busy="true">
        <p className="projects-loading">Loading projects…</p>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="projects-panel">
        <p className="projects-error" role="alert">
          {state.message}
        </p>
        <button
          className="save-button"
          type="button"
          onClick={() => {
            setState({ kind: "loading" });
            void refresh(status);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  const { me, projects } = state;
  const limitLabel =
    typeof me.projectLimit === "number" ? me.projectLimit : "your";
  const newProjectDisabled = me.atLimit && me.effectiveTier === "free";

  return (
    <section className="projects-panel">
      {me.overLimit ? (
        <div className="projects-overlimit-banner" role="status">
          You're over the tier limit of {limitLabel} projects. Delete one or
          upgrade to unlock editing.
        </div>
      ) : null}

      <header className="projects-header">
        <div>
          <h1 className="projects-title">Your projects</h1>
          <p className="projects-subtitle">
            {status === "trashed"
              ? "Trashed projects are kept for 14 days before permanent deletion."
              : `${me.activeProjectCount} of ${
                  me.projectLimit ?? "∞"
                } projects saved.`}
          </p>
        </div>
        <div className="projects-actions">
          <div
            className="projects-status-toggle"
            role="tablist"
            aria-label="Project status filter"
          >
            <button
              type="button"
              role="tab"
              aria-selected={status === "active"}
              className={`projects-status-tab${
                status === "active" ? " is-active" : ""
              }`}
              onClick={() => handleStatusToggle("active")}
            >
              Active
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={status === "trashed"}
              className={`projects-status-tab${
                status === "trashed" ? " is-active" : ""
              }`}
              onClick={() => handleStatusToggle("trashed")}
            >
              Trash
            </button>
          </div>
          {status === "active" ? (
            newProjectDisabled ? (
              <button
                className="projects-new-button"
                type="button"
                disabled
                title="You've reached your free-tier project limit. Delete one or upgrade to make room."
              >
                + New project
              </button>
            ) : (
              <a className="projects-new-button" href="/">
                + New project
              </a>
            )
          ) : null}
        </div>
      </header>

      {actionError ? (
        <p className="projects-error" role="alert">
          {actionError}
        </p>
      ) : null}

      {projects.length === 0 ? (
        <div className="projects-empty">
          {status === "trashed" ? (
            <>
              <p>No trashed projects.</p>
              <button
                className="save-button"
                type="button"
                onClick={() => handleStatusToggle("active")}
              >
                Back to active projects
              </button>
            </>
          ) : (
            <>
              <p>No projects yet. Upload some artwork to get started.</p>
              {newProjectDisabled ? null : (
                <a className="projects-cta" href="/">
                  Upload your first artwork
                </a>
              )}
            </>
          )}
        </div>
      ) : (
        <ul className="projects-grid">
          {projects.map((project) => (
            <li key={project.id} className="project-tile">
              <button
                type="button"
                className="project-tile-open"
                onClick={() =>
                  assignLocation(
                    `/?project=${encodeURIComponent(project.id)}`
                  )
                }
                aria-label={`Open ${project.name}`}
              >
                <div className="project-tile-thumb-frame">
                  {project.thumbnail ? (
                    <img
                      className="project-tile-thumb"
                      src={`data:image/jpeg;base64,${project.thumbnail}`}
                      alt=""
                    />
                  ) : (
                    <div className="project-tile-thumb-empty" aria-hidden="true">
                      No preview
                    </div>
                  )}
                </div>
                <div className="project-tile-body">
                  <h2 className="project-tile-name">{project.name}</h2>
                  <p className="project-tile-meta">
                    {formatRelativeTime(project.lastViewedAt)}
                  </p>
                </div>
              </button>
              {status === "active" ? (
                <button
                  type="button"
                  className="project-tile-delete"
                  aria-label={`Delete ${project.name}`}
                  onClick={() => handleDelete(project)}
                >
                  ×
                </button>
              ) : (
                <button
                  type="button"
                  className="project-tile-restore"
                  onClick={() => handleRestore(project)}
                >
                  Restore
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
