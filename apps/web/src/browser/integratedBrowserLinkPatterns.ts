// Matching for the "always open in integrated browser" URL patterns stored in
// `ClientSettings.integratedBrowserUrlPatterns`. Patterns are host names with
// an optional path prefix — `*.github.com`, `docs.example.com/api`. A leading
// `*.` matches the apex domain and any subdomain; a plain host matches only
// itself. Bare domains normalize to `*.domain.com` on entry. No schemes,
// ports, queries, or fragments.

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
 * Uppercases percent-escape hex digits so equivalent escapes compare equal
 * (`URL.pathname` preserves the casing it was given, so `/%c3%bcber` and
 * `/%C3%BCber` would otherwise never prefix-match).
 */
function normalizePercentEscapes(pathname: string): string {
  return pathname.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
}

/**
 * Parses a raw user-entered pattern. Returns null when the pattern is invalid
 * (schemes, ports, whitespace, queries, fragments, empty host, or illegal
 * host characters). Matching compares `URL.pathname`, so `?`/`#` in a
 * pattern could never match and are rejected up front. Schemes and ports are
 * caught by the host character check — both leave a `:` in the host segment.
 */
export function parseIntegratedBrowserUrlPattern(raw: string): IntegratedBrowserUrlPattern | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /[\s?#]/u.test(trimmed)) {
    return null;
  }

  const slashIndex = trimmed.indexOf("/");
  const rawHost = slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex);
  const rawPath = slashIndex === -1 ? null : trimmed.slice(slashIndex);

  const lowerHost = rawHost.toLowerCase();
  if (!HOST_PATTERN_CHARS.test(lowerHost)) {
    return null;
  }
  // `*` is only meaningful as a leading `*.` wildcard with a non-empty apex;
  // reject it anywhere else so a pattern that would silently never match is
  // flagged at entry. Validated before `www.` stripping — stripping first
  // would silently widen `www.*.example.com` into a valid `*.example.com`.
  if (lowerHost.includes("*")) {
    const apex = lowerHost.startsWith("*.") ? lowerHost.slice(2) : "";
    if (apex.length === 0 || apex.includes("*")) {
      return null;
    }
  }
  const host = stripWww(lowerHost);
  if (host.length === 0) {
    return null;
  }
  // Reject structurally invalid hosts (`example..com`, `.example.com`,
  // `-example.com`, `example.com.`) — they pass the character check but can
  // never match a real link hostname, so the pattern would be silently dead.
  const labels = (host.startsWith("*.") ? host.slice(2) : host).split(".");
  if (labels.some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) {
    return null;
  }

  if (rawPath === null || rawPath === "/") {
    return { host, pathPrefix: null };
  }
  // Canonicalize through URL so the prefix uses the same representation as
  // the `URL.pathname` it is compared against (e.g. `/über` → `/%C3%BCber`).
  let pathname: string;
  try {
    pathname = normalizePercentEscapes(new URL(`https://h${rawPath}`).pathname);
  } catch {
    return null;
  }
  if (pathname === "/") {
    return { host, pathPrefix: null };
  }
  return {
    host,
    pathPrefix: pathname.endsWith("/") ? pathname.slice(0, -1) : pathname,
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
    return (
      pattern.pathPrefix === null ||
      pathMatchesPrefix(normalizePercentEscapes(url.pathname), pattern.pathPrefix)
    );
  });
}
