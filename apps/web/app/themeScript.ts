/** localStorage key for the visitor's explicit light/dark choice. */
export const THEME_STORAGE_KEY = "muralist-theme";

/**
 * Inlined into <head> by layout.tsx so data-theme is set before first paint
 * (no flash of the wrong theme on a static export). Order: saved toggle
 * choice, else the visitor's system setting (prefers-color-scheme), else
 * dark. Every storage/matchMedia access is guarded.
 */
export const themeInitScript = `(function(){var t;try{t=localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){}if(t!=="light"&&t!=="dark"){try{t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}catch(e){t="dark"}}document.documentElement.setAttribute("data-theme",t)})()`;
