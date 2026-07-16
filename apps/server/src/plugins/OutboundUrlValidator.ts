// @effect-diagnostics nodeBuiltinImport:off
import * as NodeDns from "node:dns";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class OutboundUrlError extends Data.TaggedError("OutboundUrlError")<{
  readonly reason: string;
}> {}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface UrlValidatorDeps {
  readonly lookup: (
    host: string,
  ) => Effect.Effect<ReadonlyArray<string | ResolvedAddress>, OutboundUrlError | Error>;
  readonly allowHttpLoopback?: boolean | undefined;
}

export interface ResolvedOutboundUrl {
  readonly url: URL;
  readonly addresses: ReadonlyArray<ResolvedAddress>;
}

const normalizeResolvedAddress = (entry: string | ResolvedAddress): ResolvedAddress => {
  if (typeof entry !== "string") return entry;
  return { address: entry, family: entry.includes(":") ? 6 : 4 };
};

// Hard deadline on getaddrinfo: an unresponsive resolver can otherwise hold
// the request for the OS retry window (15-30s+) BEFORE the transport-level
// timeout even starts. getaddrinfo itself is not cancellable, so the orphaned
// lookup resolves harmlessly in the background after the fiber moves on.
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

export const defaultLookup = (
  host: string,
): Effect.Effect<ReadonlyArray<ResolvedAddress>, OutboundUrlError> =>
  Effect.tryPromise({
    try: async () => {
      const records = await NodeDns.promises.lookup(host, { all: true });
      return records.map(
        (record): ResolvedAddress => ({
          address: record.address,
          family: record.family === 6 ? 6 : 4,
        }),
      );
    },
    catch: (error) => {
      const code = (error as { code?: unknown })?.code;
      const suffix = typeof code === "string" ? ` (${code})` : "";
      return new OutboundUrlError({ reason: `DNS resolution failed for ${host}${suffix}` });
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(DNS_LOOKUP_TIMEOUT_MS),
      orElse: () => new OutboundUrlError({ reason: `DNS resolution timed out for ${host}` }),
    }),
  );

export class OutboundUrlLookup extends Context.Service<
  OutboundUrlLookup,
  UrlValidatorDeps["lookup"]
>()("t3/plugins/OutboundUrlValidator/OutboundUrlLookup") {}

export const OutboundUrlLookupLive = Layer.succeed(OutboundUrlLookup, defaultLookup);

// INVARIANT: only call this on canonical dotted decimal from WHATWG URL or DNS.
const ipv4Bytes = (ip: string): ReadonlyArray<number> | null => {
  if (!ip.includes(".") || ip.includes(":")) return null;
  const parts = ip.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts;
};

const isDisallowedV4 = (bytes: ReadonlyArray<number>): boolean => {
  const first = bytes[0] ?? -1;
  const second = bytes[1] ?? -1;
  const third = bytes[2] ?? -1;
  if (first === 0) return true;
  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 0 && third === 0) return true;
  if (first === 192 && second === 0 && third === 2) return true;
  if (first === 192 && second === 88 && third === 99) return true;
  if (first === 192 && second === 168) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first === 198 && second === 51 && third === 100) return true;
  if (first === 203 && second === 0 && third === 113) return true;
  if (first >= 224) return true;
  return false;
};

const ipv6Bytes = (raw: string): ReadonlyArray<number> | null => {
  let ip = raw.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return null;

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
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
    const value = Number.parseInt(hextet, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
};

const embeddedV4 = (bytes: ReadonlyArray<number>): ReadonlyArray<number> | null => {
  const zerosThrough = (length: number): boolean =>
    bytes.slice(0, length).every((byte) => byte === 0);
  if (zerosThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12, 16);
  }
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return bytes.slice(12, 16);
  }
  if (zerosThrough(12)) return bytes.slice(12, 16);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6);
  return null;
};

const isPrivateV6 = (raw: string): boolean => {
  const bytes = ipv6Bytes(raw);
  if (!bytes) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && (bytes[15] === 0 || bytes[15] === 1)) {
    return true;
  }
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  if ((first & 0xfe) === 0xfc) return true;
  if (first === 0xff) return true;
  // RFC 8215 local-use NAT64 (64:ff9b:1::/48). Blocked WHOLESALE rather than by
  // extracting the embedded IPv4: unlike the well-known /96 prefix, a /48 lets the
  // operator embed the IPv4 at several offsets (RFC 6052 permits /48../96 inside
  // it), so checking one offset would leave the others as an SSRF bypass — an
  // address like 64:ff9b:1::a00:1 wraps 10.0.0.1 and previously passed. Nothing on
  // this prefix is a global destination the validator can vouch for.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  ) {
    return true;
  }
  const v4 = embeddedV4(bytes);
  if (v4) return isDisallowedV4(v4);
  return false;
};

const isBlocked = (ip: string): boolean => {
  const v4 = ipv4Bytes(ip);
  if (v4) return isDisallowedV4(v4);
  return isPrivateV6(ip);
};

const isLoopback = (ip: string): boolean => {
  const v4 = ipv4Bytes(ip);
  if (v4) return v4[0] === 127;
  const bytes = ipv6Bytes(ip);
  if (!bytes) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.0/104): dns.lookup can return
  // this form for localhost on dual-stack hosts. Only the mapped form is
  // accepted — 6to4/NAT64 embeddings are NOT loopback connectivity.
  return (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff &&
    bytes[12] === 127
  );
};

const mapLookupError = (host: string, error: unknown) =>
  error instanceof OutboundUrlError
    ? error
    : new OutboundUrlError({ reason: `DNS resolution failed for ${host}` });

export const OutboundUrlValidator = {
  resolve: (
    rawUrl: string,
    deps: UrlValidatorDeps = { lookup: defaultLookup },
  ): Effect.Effect<ResolvedOutboundUrl, OutboundUrlError> =>
    Effect.gen(function* () {
      let parsed: URL;
      // @effect-diagnostics-next-line tryCatchInEffectGen:off -- WHATWG URL parsing is a synchronous guard converted to an Effect failure.
      try {
        parsed = new URL(rawUrl);
      } catch {
        return yield* new OutboundUrlError({ reason: "Malformed URL" });
      }

      const isHttps = parsed.protocol === "https:";
      const allowHttpLoopback = deps.allowHttpLoopback === true && parsed.protocol === "http:";
      if (!isHttps && !allowHttpLoopback) {
        return yield* new OutboundUrlError({ reason: "Only https:// targets are allowed" });
      }

      const addresses = yield* deps.lookup(parsed.hostname).pipe(
        Effect.map((records) => records.map(normalizeResolvedAddress)),
        Effect.mapError((error) => mapLookupError(parsed.hostname, error)),
      );
      if (addresses.length === 0) {
        return yield* new OutboundUrlError({ reason: "Host did not resolve" });
      }

      for (const address of addresses) {
        if (isHttps) {
          if (isBlocked(address.address)) {
            return yield* new OutboundUrlError({
              reason: `Resolved to a disallowed address (${address.address})`,
            });
          }
        } else if (!isLoopback(address.address)) {
          return yield* new OutboundUrlError({
            reason: `HTTP development target resolved outside loopback (${address.address})`,
          });
        }
      }

      return { url: parsed, addresses };
    }),

  validate: (rawUrl: string, deps?: UrlValidatorDeps): Effect.Effect<URL, OutboundUrlError> =>
    OutboundUrlValidator.resolve(rawUrl, deps).pipe(Effect.map((result) => result.url)),
};
