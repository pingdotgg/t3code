/**
 * Pure URL helpers shared between the preview server, desktop main process,
 * and the web and mobile clients. Centralising these guarantees the call
 * sites agree on what counts as "loopback", which hosts are private-network
 * reachable, and how to normalise a free-form URL string.
 */

import * as Schema from "effect/Schema";

const TAB_ID_PREFIX = "tab_";
let nextPreviewTabSequence = 0;

/**
 * Generate a fresh preview tab id. Lives in shared (not contracts) because
 * the contracts package is schema-only — runtime helpers belong here.
 */
export function newPreviewTabId(): string {
  nextPreviewTabSequence += 1;
  return `${TAB_ID_PREFIX}${nextPreviewTabSequence.toString(36)}`;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** Internal — used by `lsof` parsing where the host string is wire-formatted. */
export const LSOF_LOCAL_HOST_TOKENS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOSTS,
  "*",
  "[::]",
  "[::1]",
]);

const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === "[::1]") return true;
  return false;
}

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

const isSpecialPurposeIpv4Address = (parts: readonly number[]): boolean =>
  isPrivateIpv4Address(parts) ||
  parts[0]! >= 224 ||
  // Deliberately suppress the whole protocol-assignment block. IANA marks
  // .9 and .10 globally reachable, but privacy-safe false negatives are
  // preferable to disclosing another special-purpose address by mistake.
  (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
  (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
  (parts[0] === 192 && parts[1] === 88 && parts[2] === 99) ||
  (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
  (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);

export const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
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

/** Whether a hostname is eligible to be disclosed to a public favicon provider. */
export const isPublicFaviconHost = (host: string): boolean => {
  // A single trailing dot is a valid absolute DNS name. Repeated trailing
  // dots are malformed and can conceal legacy numeric forms such as 127.1.
  if (host.endsWith("..")) return false;
  const normalized = normalizeHostname(host);
  if (isPrivateNetworkHost(normalized)) return false;
  if (
    [".alt", ".example", ".internal", ".invalid", ".onion", ".test"].some(
      (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
    )
  ) {
    return false;
  }
  const ipv4 = parseIpv4Address(normalized) ?? parseIpv4MappedIpv6Address(normalized);
  if (ipv4) return !isSpecialPurposeIpv4Address(ipv4);
  if (!normalized.includes(":")) return true;
  const ipv6 = parseIpv6Address(normalized);
  if (!ipv6) return false;
  if (ipv6PrefixMatches(ipv6, [0x0064, 0xff9b, 0, 0, 0, 0, 0, 0], 96)) {
    const embeddedIpv4 = [ipv6[6]! >>> 8, ipv6[6]! & 0xff, ipv6[7]! >>> 8, ipv6[7]! & 0xff];
    return !isSpecialPurposeIpv4Address(embeddedIpv4);
  }
  const first = ipv6[0]!;
  if ((first & 0xe000) !== 0x2000) return false;
  if (ipv6PrefixMatches(ipv6, [0x2001, 0, 0, 0, 0, 0, 0, 0], 23)) {
    const publicProtocolAssignment =
      (ipv6[1] === 1 &&
        ipv6.slice(2, 7).every((part) => part === 0) &&
        [1, 2, 3].includes(ipv6[7]!)) ||
      ipv6PrefixMatches(ipv6, [0x2001, 3, 0, 0, 0, 0, 0, 0], 32) ||
      ipv6PrefixMatches(ipv6, [0x2001, 4, 0x0112, 0, 0, 0, 0, 0], 48) ||
      ipv6PrefixMatches(ipv6, [0x2001, 0x20, 0, 0, 0, 0, 0, 0], 28) ||
      ipv6PrefixMatches(ipv6, [0x2001, 0x30, 0, 0, 0, 0, 0, 0], 28);
    return publicProtocolAssignment;
  }
  if (ipv6PrefixMatches(ipv6, [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32)) return false;
  if (ipv6PrefixMatches(ipv6, [0x2002, 0, 0, 0, 0, 0, 0, 0], 16)) return false;
  if (first === 0x3fff && (ipv6[1]! & 0xf000) === 0) return false;
  return true;
};

/** True when a raw URL string looks like a loopback dev URL we can preview. */
export function isPreviewableUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export class PreviewUrlNormalizationError extends Schema.TaggedErrorClass<PreviewUrlNormalizationError>()(
  "PreviewUrlNormalizationError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export const isPreviewUrlNormalizationError = Schema.is(PreviewUrlNormalizationError);

function previewUrlProtocol(rawUrl: string): string | undefined {
  return /^([A-Za-z][A-Za-z\d+.-]*):/.exec(rawUrl)?.[1]?.toLowerCase().concat(":");
}

/**
 * Normalise a free-form URL string into a fully-qualified `http(s)://` URL.
 *
 * - Bare loopback hosts (`localhost`, `localhost:5173`) become `http://...`.
 * - Bare public hosts (`example.com`) become `https://...`.
 * - Already-qualified URLs are validated and returned as `URL.href`.
 *
 * Throws `PreviewUrlNormalizationError` for empty, unparseable, or
 * unsupported-protocol inputs.
 */
export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new PreviewUrlNormalizationError({ inputLength: rawUrl.length, reason: "empty" });
  }
  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = trimmed.includes("://")
    ? trimmed
    : `${useHttp ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "parse",
      protocol: previewUrlProtocol(candidate),
      cause,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "unsupported-protocol",
      protocol: parsed.protocol,
    });
  }
  return parsed.href;
}
