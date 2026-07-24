/**
 * netHost - Pure host/hostname predicates and parsing.
 *
 * Dependency-free so it can be imported from auth modules, startup code, and
 * HTTP layers without creating module cycles.
 *
 * @module netHost
 */

// Strict 127.0.0.0/8 check: a prefix test would also accept DNS names like
// "127.attacker.example", which must not count as loopback anywhere this is
// used as a security boundary.
const isLoopbackIpv4 = (host: string): boolean => {
  const octets = host.split(".");
  if (octets.length !== 4) {
    return false;
  }
  const values = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : -1));
  return values[0] === 127 && values.every((value) => value >= 0 && value <= 255);
};

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return host === "localhost" || host === "::1" || host === "[::1]" || isLoopbackIpv4(host);
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

/**
 * Extracts the hostname from a raw `Host` request header, handling ports,
 * bracketed IPv6 literals, and surrounding whitespace. Returns null for
 * missing or malformed values.
 */
export const parseHostHeaderHostname = (hostHeader: string | undefined): string | null => {
  const trimmed = hostHeader?.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/")) {
    return null;
  }

  // URL handles `host[:port]` and `[v6]:port` uniformly and rejects garbage.
  try {
    const parsed = new URL(`http://${trimmed}`);
    return parsed.hostname.length > 0 ? parsed.hostname : null;
  } catch {
    return null;
  }
};

/**
 * True when a raw `Host` request header names a loopback host. Malformed or
 * missing headers are NOT loopback: this is used as an auth guard, so parse
 * failures must fail closed (unlike `isLoopbackHost`, whose undefined input
 * means "no bind host configured" and defaults open).
 */
export const isLoopbackHostHeader = (hostHeader: string | undefined): boolean => {
  const hostname = parseHostHeaderHostname(hostHeader);
  if (hostname === null) {
    return false;
  }
  return isLoopbackHost(normalizeHost(hostname));
};
