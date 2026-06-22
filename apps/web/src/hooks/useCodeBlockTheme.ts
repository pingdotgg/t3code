import { useActiveEnvironmentId } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { ensureCustomThemeRegistered } from "../lib/shikiThemeRegistry";
import { useSettings } from "./useSettings";

export interface CodeBlockThemeState {
  /** The selected VSCode theme id, or `null` when using the default pierre themes. */
  readonly activeThemeId: string | null;
  /** `editor.background` of the resolved theme, for the code-area background. */
  readonly background: string | null;
  /** `editor.foreground` of the resolved theme. */
  readonly foreground: string | null;
  /**
   * `true` once the selected theme's JSON has been fetched and registered with
   * the highlighter. Callers should keep using the default theme until this is
   * `true` to avoid referencing a theme name that isn't loaded yet.
   */
  readonly isReady: boolean;
}

const INACTIVE: CodeBlockThemeState = {
  activeThemeId: null,
  background: null,
  foreground: null,
  isReady: false,
};

/**
 * Resolves the user-selected VSCode theme for code blocks. The selected id is a
 * client-only setting; the resolved theme JSON is fetched from the server in
 * real time, registered with the shared Shiki highlighter, and surfaced here so
 * `ChatMarkdown` can apply both syntax colors and the code-area background.
 */
export function useCodeBlockTheme(): CodeBlockThemeState {
  const codeBlockThemeId = useSettings((settings) => settings.codeBlockThemeId);
  const environmentId = useActiveEnvironmentId();

  const { data } = useEnvironmentQuery(
    codeBlockThemeId && environmentId
      ? serverEnvironment.themesGetJson({ environmentId, input: { id: codeBlockThemeId } })
      : null,
  );

  if (!codeBlockThemeId) {
    return INACTIVE;
  }

  const resolved = data && data.id === codeBlockThemeId ? data : null;
  if (!resolved) {
    // Selected but not yet fetched (or failed) — caller falls back to default.
    return { activeThemeId: codeBlockThemeId, background: null, foreground: null, isReady: false };
  }

  // Idempotent: registers the theme with the highlighter the first time its JSON
  // arrives so the synchronous `codeToHtml({ theme: id })` call can resolve it.
  ensureCustomThemeRegistered(resolved.id, resolved.theme);

  return {
    activeThemeId: codeBlockThemeId,
    background: resolved.background ?? null,
    foreground: resolved.foreground ?? null,
    isReady: true,
  };
}
