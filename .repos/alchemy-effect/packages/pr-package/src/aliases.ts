/**
 * Pretty install URL parsing.
 *
 * Every non-`/projects/...` GET hands its full `URL` to `parseAliasUrl`,
 * which returns `{ pkgName, tag }` to 301 to the canonical
 * `/projects/:pkgName/tags/:tag` route, or `null` to fall through.
 *
 * Defaults to `() => null` — no aliases recognized.
 */

export interface AliasMatch {
  pkgName: string;
  tag: string;
}

export type ParseAliasUrl = (url: URL) => AliasMatch | null;

export interface AliasParserOptions {
  /** Parse a request URL into a package match, or `null` to fall through. */
  parseAliasUrl?: ParseAliasUrl;
}

const encodePath = (s: string) =>
  s.split("/").map(encodeURIComponent).join("/");

export const aliasRedirectPath = (match: AliasMatch): string =>
  `/projects/${encodePath(match.pkgName)}/tags/${encodeURIComponent(match.tag)}`;
