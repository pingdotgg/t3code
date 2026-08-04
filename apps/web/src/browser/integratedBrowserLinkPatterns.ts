// Matching for the "always open in integrated browser" URL patterns stored in
// `ClientSettings.integratedBrowserUrlPatterns`. Patterns are host names with
// an optional path prefix — `*.github.com`, `docs.example.com/api`. A leading
// `*.` matches the apex domain and any subdomain; a plain host matches only
// itself. Bare domains normalize to `*.domain.com` on entry. No schemes, no
// ports.

export interface IntegratedBrowserUrlPattern {
  /** Lowercased host pattern with any leading `www.` stripped. */
  readonly host: string;
  /** Normalized path prefix (leading `/`, no trailing `/`), or null for host-only patterns. */
  readonly pathPrefix: string | null;
}

const HOST_PATTERN_CHARS = /^[a-z0-9*.-]+$/u;

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Parses a raw user-entered pattern. Returns null when the pattern is invalid
 * (schemes, ports, whitespace, empty host, or illegal host characters).
 */
export function parseIntegratedBrowserUrlPattern(raw: string): IntegratedBrowserUrlPattern | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.includes(":") || /\s/u.test(trimmed)) {
    return null;
  }

  const slashIndex = trimmed.indexOf("/");
  const rawHost = slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex);
  const rawPath = slashIndex === -1 ? null : trimmed.slice(slashIndex);

  const host = stripWww(rawHost.toLowerCase());
  if (host.length === 0 || !HOST_PATTERN_CHARS.test(host)) {
    return null;
  }
  // `*` is only meaningful as a leading `*.` wildcard; reject it anywhere else
  // so a pattern that would silently never match is flagged at entry.
  if (host.includes("*") && (!host.startsWith("*.") || host.slice(2).includes("*"))) {
    return null;
  }

  if (rawPath === null || rawPath === "/") {
    return { host, pathPrefix: null };
  }
  return {
    host,
    pathPrefix: rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath,
  };
}

/**
 * Canonical string form for storage and display. A bare domain with no
 * subdomain specified becomes `*.domain.com`; anything more specific (a
 * subdomain, a wildcard, a single-label host) is kept as entered. Returns
 * null for invalid patterns.
 */
export function normalizeIntegratedBrowserUrlPattern(raw: string): string | null {
  const pattern = parseIntegratedBrowserUrlPattern(raw);
  if (pattern === null) {
    return null;
  }
  const host =
    !pattern.host.includes("*") && pattern.host.split(".").length === 2
      ? `*.${pattern.host}`
      : pattern.host;
  return `${host}${pattern.pathPrefix ?? ""}`;
}

/**
 * A leading `*.` matches the apex domain and any subdomain at any depth:
 * `*.github.com` matches `github.com`, `gist.github.com`, `a.b.github.com`.
 * A plain host matches only itself.
 */
function hostMatchesPattern(host: string, hostPattern: string): boolean {
  if (hostPattern.startsWith("*.")) {
    const apex = hostPattern.slice(2);
    return host === apex || host.endsWith(`.${apex}`);
  }
  return host === hostPattern;
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (!pathname.startsWith(prefix)) {
    return false;
  }
  const rest = pathname.slice(prefix.length);
  return rest.length === 0 || rest.startsWith("/");
}

/**
 * Returns true when `href` is an http(s) URL whose host (and path, if the
 * pattern has one) matches any of the raw patterns. Invalid patterns and
 * unparseable hrefs never match.
 */
export function urlMatchesIntegratedBrowserPatterns(
  href: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const host = stripWww(url.hostname.toLowerCase());
  return patterns.some((raw) => {
    const pattern = parseIntegratedBrowserUrlPattern(raw);
    if (pattern === null || !hostMatchesPattern(host, pattern.host)) {
      return false;
    }
    return pattern.pathPrefix === null || pathMatchesPrefix(url.pathname, pattern.pathPrefix);
  });
}
