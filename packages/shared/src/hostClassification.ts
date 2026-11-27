export const normalizeHostname = (host: string): string =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/u, "");

const parseIpv4Address = (host: string): readonly number[] | null => {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
};

const parseIpv4MappedIpv6Address = (host: string): readonly number[] | null => {
  const normalized = normalizeHostname(host);
  if (!normalized.startsWith("::ffff:")) return null;
  const suffix = normalized.slice("::ffff:".length);
  const dotted = parseIpv4Address(suffix);
  if (dotted) return dotted;
  const hextets = suffix.split(":");
  if (hextets.length !== 2 || hextets.some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
  const high = Number.parseInt(hextets[0]!, 16);
  const low = Number.parseInt(hextets[1]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
};

const parseIpv6Address = (host: string): readonly number[] | null => {
  const normalized = normalizeHostname(host);
  if (!normalized.includes(":")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  if ([...head, ...tail].some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...head, ...Array.from({ length: missing }, () => "0"), ...tail].map((part) =>
    Number.parseInt(part, 16),
  );
};

const ipv6PrefixMatches = (
  address: readonly number[],
  prefix: readonly number[],
  prefixLength: number,
): boolean => {
  const fullHextets = Math.floor(prefixLength / 16);
  if (address.slice(0, fullHextets).some((part, index) => part !== prefix[index])) return false;
  const remainingBits = prefixLength % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (address[fullHextets]! & mask) === (prefix[fullHextets]! & mask);
};

const isPrivateIpv4Address = (parts: readonly number[]): boolean =>
  parts[0] === 0 ||
  parts[0] === 10 ||
  parts[0] === 127 ||
  (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
  (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
  (parts[0] === 192 && parts[1] === 168) ||
  (parts[0] === 169 && parts[1] === 254) ||
  (parts[0] === 198 && parts[1]! >= 18 && parts[1]! <= 19);

export const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
};

/** MagicDNS or fd7a:115c:a1e0::/48 identifies Tailscale; shared 100.64.0.0/10 addresses alone do not. */
export const isTailnetHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized.endsWith(".ts.net")) return true;
  const ipv6 = parseIpv6Address(normalized);
  return ipv6 !== null && ipv6PrefixMatches(ipv6, [0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0], 48);
};

export const isSharedAddressSpaceHost = (host: string): boolean => {
  const parts = parseIpv4Address(host);
  return parts !== null && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
};

export const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (
    normalized === "::" ||
    isLocalLoopbackHost(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "home.arpa" ||
    normalized.endsWith(".home.arpa") ||
    (!normalized.includes(".") && !normalized.includes(":"))
  ) {
    return true;
  }
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4Address(normalized) ?? parseIpv4MappedIpv6Address(normalized);
  if (parts) return isPrivateIpv4Address(parts);
  const firstIpv6Token = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false;
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  );
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

/** An unset, loopback, or wildcard bind host shares the port that `localhost` clients reach. */
export const listensOnLoopback = (host: string | undefined): boolean =>
  host === undefined || host === "" || isWildcardHost(host) || isLocalLoopbackHost(host);

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
