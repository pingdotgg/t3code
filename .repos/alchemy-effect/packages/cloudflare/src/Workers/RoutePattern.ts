/**
 * Cloudflare Workers route patterns (`api.example.com/users/*`), parsed and
 * matched per Cloudflare's rules: an optional `http://` / `https://` scheme,
 * an optional leading `*` on the host (zero or more of any character), an
 * optional trailing `*` on the path, case-insensitive hosts, case-sensitive
 * paths, and the most specific matching pattern wins.
 *
 * `parseRoutePattern` and `matchRoute` are self-contained function
 * declarations on purpose: the local edge router embeds their source
 * verbatim (see {@link routeMatcherSource}).
 */

export interface ParsedRoutePattern {
  /** Lowercased host, without the leading `*` of a wildcard host. */
  readonly host: string;
  readonly hostWildcard: boolean;
  /** Path, without the trailing `*` of a prefix path. */
  readonly path: string;
  readonly pathWildcard: boolean;
  readonly scheme: "http" | "https" | undefined;
}

export function parseRoutePattern(pattern: string): ParsedRoutePattern {
  const scheme = /^(https?):\/\//i.exec(pattern)?.[1]?.toLowerCase() as
    | "http"
    | "https"
    | undefined;
  const bare = pattern.replace(/^https?:\/\//i, "");
  const slash = bare.indexOf("/");
  const host = (slash < 0 ? bare : bare.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? "/*" : bare.slice(slash);
  return {
    host: host.startsWith("*") ? host.slice(1) : host,
    hostWildcard: host.startsWith("*"),
    path: path.endsWith("*") ? path.slice(0, -1) : path,
    pathWildcard: path.endsWith("*"),
    scheme,
  };
}

/**
 * The most specific route whose pattern matches `host` + `path`: an exact
 * host beats a wildcard host, then the longer host, then the longer path,
 * then an exact path beats a prefix.
 */
export function matchRoute<R extends { readonly pattern: string }>(
  routes: ReadonlyArray<R>,
  host: string,
  path: string,
): R | undefined {
  const lowerHost = host.toLowerCase();
  let best: R | undefined;
  let bestScore: number[] = [];
  for (const route of routes) {
    const p = parseRoutePattern(route.pattern);
    const hostMatches = p.hostWildcard ? lowerHost.endsWith(p.host) : lowerHost === p.host;
    const pathMatches = p.pathWildcard ? path.startsWith(p.path) : path === p.path;
    if (!hostMatches || !pathMatches) continue;
    const score = [p.hostWildcard ? 0 : 1, p.host.length, p.path.length, p.pathWildcard ? 0 : 1];
    let cmp = best === undefined ? 1 : 0;
    for (let i = 0; cmp === 0 && i < score.length; i++) {
      cmp = score[i]! - bestScore[i]!;
    }
    if (cmp > 0) {
      best = route;
      bestScore = score;
    }
  }
  return best;
}

/** Source of the matcher, for embedding in a generated worker module. */
export const routeMatcherSource = () => `${parseRoutePattern.toString()}\n${matchRoute.toString()}`;

/** The literal hostname of a pattern, or `undefined` for a wildcard host. */
export const routePatternHost = (pattern: string): string | undefined => {
  const parsed = parseRoutePattern(pattern);
  return parsed.hostWildcard ? undefined : parsed.host;
};

/** Whether a pattern's host component matches `host`. */
export const routePatternMatchesHost = (pattern: string, host: string): boolean => {
  const parsed = parseRoutePattern(pattern);
  const lower = host.toLowerCase();
  return parsed.hostWildcard ? lower.endsWith(parsed.host) : lower === parsed.host;
};

/**
 * The deployed origin a pattern serves (`https://api.example.com`), or
 * `undefined` for a wildcard host.
 */
export const routePatternUrl = (pattern: string): string | undefined => {
  const parsed = parseRoutePattern(pattern);
  return parsed.hostWildcard ? undefined : `${parsed.scheme ?? "https"}://${parsed.host}`;
};
