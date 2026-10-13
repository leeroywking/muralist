"use client";

import { useEffect, useState } from "react";
import { THEME_STORAGE_KEY } from "./themeScript";

type Theme = "dark" | "light";

function readSaved(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Header light/dark switch. The effective theme lives on
 * <html data-theme>; the glyph is chosen by CSS from that attribute, so it
 * is correct before hydration. Until the visitor clicks, the page follows
 * live changes to their system setting.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "light" ? "light" : "dark");

    let query: MediaQueryList | null = null;
    try {
      query = window.matchMedia("(prefers-color-scheme: light)");
    } catch {
      return;
    }
    const onChange = () => {
      if (readSaved()) return;
      const next = systemTheme();
      applyTheme(next);
      setTheme(next);
    };
    query.addEventListener("change", onChange);
    return () => query?.removeEventListener("change", onChange);
  }, []);

  const isDark = theme !== "light";

  function toggle() {
    const next: Theme = isDark ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice lasts for this page view only.
    }
  }

  return (
    <button
      type="button"
      role="switch"
      className="theme-toggle"
      aria-label="Dark mode"
      aria-checked={isDark}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggle}
    >
      {/* Moon (shown in dark) and sun (shown in light); CSS picks one. */}
      <svg className="theme-toggle-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      <svg className="theme-toggle-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
