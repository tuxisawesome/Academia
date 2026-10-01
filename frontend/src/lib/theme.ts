import type { Prefs } from "../api/types";

const KEY = "academia-theme";
/** Browser and installed-app title bar colours (--bg in tokens.css); also in theme-init.js. */
const THEME_COLORS = { light: "#F5EFE3", dark: "#191612" } as const;

/** The colour for a theme-color meta tag scoped to `media`: an explicit choice wins over the OS scheme. */
export function themeColorFor(theme: Prefs["theme"], media: string): string {
  if (theme === "light" || theme === "dark") return THEME_COLORS[theme];
  return THEME_COLORS[media.includes("dark") ? "dark" : "light"];
}

export function applyTheme(theme: Prefs["theme"]): void {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = themeColorFor(theme, meta.getAttribute("media") ?? "");
  }
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
}

export function effectiveDark(): boolean {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
