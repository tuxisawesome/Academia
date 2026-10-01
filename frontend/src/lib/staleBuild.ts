// After an update the server only serves the new release's files, so a tab opened before it fails
// to load code-split chunks (the reader) by their old hashed names. A reload picks up the new build.

const RELOADED_AT = "academia-stale-build-reload";

/** Whether `error` is a failure to load a code-split module or its CSS. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}

/**
 * Reloads the page to pick up the new build, unless it already did so in the last `minInterval`
 * ms (a broken deploy must not reload forever) or the device is offline. Returns whether it did.
 */
export function reloadForNewBuild(
  reload: () => void = () => window.location.reload(),
  now = Date.now(),
  minInterval = 10_000,
): boolean {
  if (navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT)) || 0;
    if (now - last < minInterval) return false;
    sessionStorage.setItem(RELOADED_AT, String(now));
  } catch {
    return false; // without storage there is no loop guard
  }
  reload();
  return true;
}
