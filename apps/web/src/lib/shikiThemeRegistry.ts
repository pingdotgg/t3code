import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";

/**
 * Tracks which user-selected VSCode theme ids have already been registered with
 * the shared Shiki highlighter (the registry inside `@pierre/diffs` is a global
 * singleton). Registration is a no-op after the first call for a given id.
 */
const registeredThemeIds = new Set<string>();

/**
 * Register a resolved VSCode theme (JSON fetched from the server) with the
 * shared highlighter under `id`. Idempotent — safe to call on every render. The
 * theme's `name` is forced to `id` so `codeToHtml({ theme: id })` and
 * `getSharedHighlighter({ themes: [id] })` resolve the same theme.
 */
export function ensureCustomThemeRegistered(id: string, theme: unknown): void {
  if (registeredThemeIds.has(id)) {
    return;
  }
  registeredThemeIds.add(id);
  const themeObject =
    theme !== null && typeof theme === "object"
      ? ({ ...(theme as Record<string, unknown>), name: id } as ThemeRegistration)
      : (theme as ThemeRegistration);
  registerCustomTheme(id, () => Promise.resolve(themeObject));
}

export function isCustomThemeRegistered(id: string): boolean {
  return registeredThemeIds.has(id);
}
