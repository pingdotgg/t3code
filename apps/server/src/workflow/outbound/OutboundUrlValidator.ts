/**
 * SSRF-aware outbound URL validator.
 *
 * Honest limitation / DNS-rebinding caveat:
 *   The HTTP stack used at delivery time (global `fetch`) cannot be pinned to a
 *   specific pre-resolved IP address.  Re-validating at delivery time (TOCTOU
 *   mitigation) significantly raises the bar for a rebinding attack, but a
 *   determined attacker who controls DNS could still swap the record between
 *   the validation check and the subsequent `fetch`.  Full prevention would
 *   require a custom HTTP client that connects to the IP returned by our own
 *   resolver.  This is a known, documented limitation — not a silent bug.
 */

import { Data, Effect } from "effect";
import * as NodeDns from "node:dns";

export class OutboundUrlError extends Data.TaggedError("OutboundUrlError")<{
  readonly reason: string;
}> {}

export interface UrlValidatorDeps {
  readonly lookup: (host: string) => Effect.Effect<ReadonlyArray<string>, OutboundUrlError>;
}

const defaultLookup = (host: string): Effect.Effect<ReadonlyArray<string>, OutboundUrlError> =>
  Effect.tryPromise({
    try: async () => {
      const records = await NodeDns.promises.lookup(host, { all: true });
      return records.map((r) => r.address);
    },
    catch: (error) => {
      const code = (error as { code?: unknown })?.code;
      const suffix = typeof code === "string" ? ` (${code})` : "";
      return new OutboundUrlError({ reason: `DNS resolution failed for ${host}${suffix}` });
    },
  });

// INVARIANT: only ever called on canonical dotted-decimal — the host from
// `new URL(...)` (already normalized) or an address string from `dns.lookup`
// output. Because of that, JS `Number()`'s octal/hex leniency
// (e.g. `Number("0177") === 177`) is NOT reachable here, and this MUST stay
// true: never call `isBlocked`/`ipv4Bytes` on a raw, un-normalized host string.
const ipv4Bytes = (ip: string): ReadonlyArray<number> | null => {
  if (!ip.includes(".") || ip.includes(":")) return null;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return null;
  return parts;
};

// Blocks every IPv4 range that is NOT globally-routable unicast, per the IANA
// special-purpose registry (RFC 6890 and friends). User-configurable outbound
// webhooks must only reach public hosts, so we deny private, shared, loopback,
// link-local, protocol-assignment, documentation/TEST-NET, benchmarking, 6to4
// relay anycast, multicast, reserved/future, and broadcast space.
const isDisallowedV4 = (b: ReadonlyArray<number>): boolean => {
  const a = b[0] ?? -1;
  const second = b[1] ?? -1;
  const third = b[2] ?? -1;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 100 && second >= 64 && second <= 127) return true; // 100.64/10 CGNAT (shared)
  if (a === 169 && second === 254) return true; // 169.254/16 link-local (incl. cloud-metadata 169.254.169.254)
  if (a === 172 && second >= 16 && second <= 31) return true; // 172.16/12 private
  if (a === 192 && second === 0 && third === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 192 && second === 0 && third === 2) return true; // 192.0.2/24 TEST-NET-1 (documentation)
  if (a === 192 && second === 88 && third === 99) return true; // 192.88.99/24 6to4 relay anycast
  if (a === 192 && second === 168) return true; // 192.168/16 private
  if (a === 198 && (second === 18 || second === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && second === 51 && third === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && second === 0 && third === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved/future + 255.255.255.255 broadcast
  return false;
};

// Expand any IPv6 textual form (compressed `::`, embedded dotted-IPv4 suffix,
// zone id) into its canonical 16 bytes. Returns null for anything that does not
// parse as IPv6 — callers MUST fail closed on null. A string-regex approach
// (matching only `::ffff:1.2.3.4`) silently misses the hex-hextet form
// (`::ffff:7f00:1`), the fully-expanded form, IPv4-compatible (`::7f00:1`), and
// NAT64 (`64:ff9b::`), all of which route to the same internal IPv4.
const ipv6Bytes = (raw: string): ReadonlyArray<number> | null => {
  let ip = raw.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return null;
  // Convert a trailing dotted-quad (e.g. `::ffff:127.0.0.1`) into two hextets.
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4Bytes(tail);
    if (!v4) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tailParts = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let hextets: ReadonlyArray<string>;
  if (tailParts === null) {
    hextets = head;
  } else {
    const fill = 8 - head.length - tailParts.length;
    if (fill < 0) return null;
    hextets = [...head, ...Array(fill).fill("0"), ...tailParts];
  }
  if (hextets.length !== 8) return null;
  const bytes: number[] = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    const n = parseInt(h, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
};

// If these 16 bytes embed an IPv4 address (mapped, compatible, NAT64, or 6to4),
// return that IPv4's bytes so the v4 allow/deny rules apply to it.
const embeddedV4 = (b: ReadonlyArray<number>): ReadonlyArray<number> | null => {
  const zerosThrough = (n: number): boolean => b.slice(0, n).every((x) => x === 0);
  // ::ffff:0:0/96 IPv4-mapped
  if (zerosThrough(10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12, 16);
  // 64:ff9b::/96 well-known NAT64
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  )
    return b.slice(12, 16);
  // ::/96 IPv4-compatible (deprecated). :: and ::1 are handled separately.
  if (zerosThrough(12)) return b.slice(12, 16);
  // 2002::/16 6to4 — embedded v4 in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
  return null;
};

const isPrivateV6 = (raw: string): boolean => {
  const b = ipv6Bytes(raw);
  // Fail closed: an address we cannot canonicalise is not provably public.
  if (!b) return true;
  // ::1 loopback / :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return true;
  const first = b[0] ?? 0;
  const second = b[1] ?? 0;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xff) return true; // ff00::/8 multicast (matches IPv4 224/4 block)
  const v4 = embeddedV4(b);
  if (v4) return isDisallowedV4(v4);
  return false;
};

const isBlocked = (ip: string): boolean => {
  const v4 = ipv4Bytes(ip);
  if (v4) return isDisallowedV4(v4);
  return isPrivateV6(ip);
};

export const OutboundUrlValidator = {
  validate: (
    rawUrl: string,
    deps: UrlValidatorDeps = { lookup: defaultLookup },
  ): Effect.Effect<URL, OutboundUrlError> =>
    Effect.gen(function* () {
      let parsed: URL;
      // @effect-diagnostics-next-line tryCatchInEffectGen:off -- synchronous URL parse guard; not an Effect failure
      try {
        parsed = new URL(rawUrl);
      } catch {
        return yield* new OutboundUrlError({ reason: "Malformed URL" });
      }
      if (parsed.protocol !== "https:") {
        return yield* new OutboundUrlError({ reason: "Only https:// targets are allowed" });
      }
      const addrs = yield* deps.lookup(parsed.hostname);
      if (addrs.length === 0) {
        return yield* new OutboundUrlError({ reason: "Host did not resolve" });
      }
      for (const addr of addrs) {
        if (isBlocked(addr)) {
          return yield* new OutboundUrlError({
            reason: `Resolved to a disallowed address (${addr})`,
          });
        }
      }
      return parsed;
    }),
};
