import type { Prefs } from "../api/types";

const KEY = "academia-theme";

export function applyTheme(theme: Prefs["theme"]): void {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
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
