/**
 * The in-app path to go to after signing in, from the `next` query parameter. Anything that
 * doesn't resolve to this origin (`//host`, `/\host`, `https://…`) falls back to the library.
 */
export function safeNext(next: string | null, origin = window.location.origin): string {
  if (!next || !next.startsWith("/")) return "/";
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
