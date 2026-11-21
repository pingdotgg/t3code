// @effect-diagnostics nodeBuiltinImport:off - Effect has no NodeNet.BlockList, DNS lookup, or pinned undici Agent for metadata-host SSRF checks.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import { PrinterOperationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import type * as Undici from "undici";

export class PrinterRequestGuard extends Context.Service<
  PrinterRequestGuard,
  () => Effect.Effect<void, PrinterOperationError>
>()("t3/printer/PrinterUrlGuard/PrinterRequestGuard") {}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export class PrinterDnsLookup extends Context.Service<
  PrinterDnsLookup,
  (hostname: string) => Effect.Effect<ReadonlyArray<ResolvedAddress>, PrinterOperationError>
>()("t3/printer/PrinterUrlGuard/PrinterDnsLookup") {}

export interface PrinterAddressPin {
  readonly candidates: ReadonlyArray<ResolvedAddress>;
  pinned: ResolvedAddress | null;
}

/** Optional host->address pin shared across a single action's preflight poll and write dispatch. */
export class PrinterPinnedAddresses extends Context.Service<
  PrinterPinnedAddresses,
  ReadonlyMap<string, PrinterAddressPin>
>()("t3/printer/PrinterUrlGuard/PrinterPinnedAddresses") {}

const requireUndici = NodeModule.createRequire(import.meta.url);

const isPrinterOperationError = Schema.is(PrinterOperationError);

const DEFAULT_TIMEOUT = Duration.seconds(8);
const MEDIA_TIMEOUT = Duration.seconds(10);
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
/** Max raw snapshot bytes so base64 (~13.33 MiB) fits within PeerMcpClient's 14 MiB image limit. */
export const MAX_PRINTER_SNAPSHOT_BYTES = 10 * 1024 * 1024;

// Preserve LAN, Tailscale, and loopback for local printers, while blocking cloud metadata & link-local ranges.
const BLOCKED_ADDRESSES = new NodeNet.BlockList();
BLOCKED_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addAddress("100.100.100.200", "ipv4");
BLOCKED_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_ADDRESSES.addAddress("::", "ipv6");
BLOCKED_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
BLOCKED_ADDRESSES.addSubnet("fd00:ec2::", 32, "ipv6");
BLOCKED_ADDRESSES.addSubnet("::ffff:0.0.0.0", 104, "ipv6");
BLOCKED_ADDRESSES.addAddress("::ffff:100.100.100.200", "ipv6");
BLOCKED_ADDRESSES.addSubnet("::ffff:169.254.0.0", 112, "ipv6");

const BLOCKED_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function isBlockedPrinterAddress(address: string): boolean {
  const bare = normalizeHost(address).split("%", 1)[0] ?? "";
  if (!bare) return true;
  if (BLOCKED_HOSTNAMES.has(bare)) return true;
  const ipVersion = NodeNet.isIP(bare);
  if (ipVersion === 4) {
    return BLOCKED_ADDRESSES.check(bare, "ipv4");
  }
  if (ipVersion === 6) {
    return BLOCKED_ADDRESSES.check(bare, "ipv6");
  }
  return false;
}

export function validatePrinterBaseUrl(
  rawUrl: string,
  operation: string,
  printerId?: string,
  options?: { readonly allowQuery?: boolean },
): Effect.Effect<URL, PrinterOperationError> {
  return Effect.try({
    try: () => {
      const trimmed = rawUrl.trim();
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http:// and https:// printer URLs are supported.");
      }
      if (parsed.username !== "" || parsed.password !== "") {
        throw new Error(
          "Remove embedded credentials from the printer URL; use the token field instead.",
        );
      }
      if (parsed.hash !== "" || trimmed.includes("#")) {
        throw new Error("Remove URL fragments (#...) from the printer URL.");
      }
      if (!options?.allowQuery && (parsed.search !== "" || trimmed.includes("?"))) {
        throw new Error("Remove query parameters (?...) from the printer backend URL.");
      }
      if (isBlockedPrinterAddress(parsed.hostname)) {
        throw new Error("Link-local and metadata endpoints are not permitted as printer hosts.");
      }
      return parsed;
    },
    catch: (error) =>
      new PrinterOperationError({
        operation,
        ...(printerId ? { printerId } : {}),
        reason: error instanceof Error ? error.message : "Invalid printer URL.",
      }),
  });
}

const resolveCheckedAddresses = Effect.fn("PrinterUrlGuard.resolveCheckedAddresses")(function* (
  url: URL,
  operation: string,
  printerId?: string,
): Effect.fn.Return<ReadonlyArray<ResolvedAddress> | null, PrinterOperationError> {
  const bareHost = normalizeHost(url.hostname);
  if (isBlockedPrinterAddress(bareHost)) {
    return yield* new PrinterOperationError({
      operation,
      ...(printerId ? { printerId } : {}),
      reason: "Link-local and metadata endpoints are not permitted as printer hosts.",
    });
  }
  if (NodeNet.isIP(bareHost) !== 0) {
    return null;
  }
  const pinnedMap = yield* Effect.serviceOption(PrinterPinnedAddresses);
  if (Option.isSome(pinnedMap)) {
    const pin = pinnedMap.value.get(bareHost);
    if (pin && pin.candidates.length > 0) {
      return pin.pinned ? [pin.pinned] : pin.candidates;
    }
  }
  const customLookup = yield* Effect.serviceOption(PrinterDnsLookup);
  const resolved = yield* Option.isSome(customLookup)
    ? customLookup.value(bareHost)
    : Effect.tryPromise({
        try: () => NodeDnsPromises.lookup(bareHost, { all: true, verbatim: true }),
        catch: () =>
          new PrinterOperationError({
            operation,
            ...(printerId ? { printerId } : {}),
            reason: `Could not resolve printer host "${bareHost}".`,
          }),
      });

  if (resolved.length === 0) {
    return yield* new PrinterOperationError({
      operation,
      ...(printerId ? { printerId } : {}),
      reason: `Could not resolve printer host "${bareHost}".`,
    });
  }
  for (const record of resolved) {
    if (isBlockedPrinterAddress(record.address)) {
      return yield* new PrinterOperationError({
        operation,
        ...(printerId ? { printerId } : {}),
        reason: `Host "${bareHost}" resolved to a blocked link-local or metadata address.`,
      });
    }
  }
  return resolved;
});

/** Resolves verified addresses once for an action; read-only preflight pins the answering IP for subsequent writes. */
export const pinPrinterHostAddress = Effect.fn("PrinterUrlGuard.pinPrinterHostAddress")(function* (
  rawUrl: string,
  operation: string,
  printerId?: string,
): Effect.fn.Return<ReadonlyMap<string, PrinterAddressPin>, PrinterOperationError> {
  const parsed = yield* validatePrinterBaseUrl(rawUrl, operation, printerId);
  const resolved = yield* resolveCheckedAddresses(parsed, operation, printerId);
  if (resolved === null || resolved.length === 0) {
    return new Map();
  }
  const bareHost = normalizeHost(parsed.hostname);
  return new Map([[bareHost, { candidates: resolved, pinned: null }]]);
});

function acquirePinnedDispatcher(
  addresses: ReadonlyArray<ResolvedAddress>,
  operation: string,
  printerId?: string,
) {
  return Effect.acquireRelease(
    Effect.try({
      try: () => {
        const undici = requireUndici("undici") as typeof Undici;
        const agent = new undici.Agent({
          allowH2: false,
          connect: {
            lookup: (_hostname, lookupOptions, callback) => {
              const requestedFamily =
                typeof lookupOptions === "number"
                  ? lookupOptions
                  : typeof lookupOptions === "object" && lookupOptions !== null
                    ? lookupOptions.family
                    : undefined;
              const matches =
                requestedFamily === 4 || requestedFamily === 6
                  ? addresses.filter((entry) => entry.family === requestedFamily)
                  : addresses;
              if (matches.length === 0) {
                const err = Object.assign(new Error("No permitted IP address matched lookup."), {
                  code: "ENOTFOUND",
                });
                callback(err, "", 4);
                return;
              }
              if (
                typeof lookupOptions === "object" &&
                lookupOptions !== null &&
                lookupOptions.all
              ) {
                (
                  callback as (
                    err: NodeJS.ErrnoException | null,
                    addresses: ReadonlyArray<{ address: string; family: number }>,
                  ) => void
                )(
                  null,
                  matches.map((entry) => ({ address: entry.address, family: entry.family })),
                );
                return;
              }
              const first = matches[0]!;
              callback(null, first.address, first.family);
            },
          },
        });
        // Pair undici's Agent with its own fetch implementation so Node's built-in undici version cannot reject the dispatcher.
        return {
          agent,
          fetch: undici.fetch as unknown as typeof globalThis.fetch,
        };
      },
      catch: () =>
        new PrinterOperationError({
          operation,
          ...(printerId ? { printerId } : {}),
          reason: "Could not initialize pinned network dispatcher for printer host.",
        }),
    }),
    ({ agent }) => Effect.promise(() => agent.close()).pipe(Effect.ignore),
  );
}

export function buildPrinterEndpoint(baseUrl: URL, path: string): URL {
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const endpoint = new URL(baseUrl.origin);
  const queryIndex = normalizedPath.indexOf("?");
  if (queryIndex >= 0) {
    endpoint.pathname = `${basePath}${normalizedPath.slice(0, queryIndex)}`;
    endpoint.search = normalizedPath.slice(queryIndex);
  } else {
    endpoint.pathname = `${basePath}${normalizedPath}`;
  }
  return endpoint;
}

/** Fast deterministic 64-bit FNV-1a fingerprint for camera frame staleness detection. */
export function fingerprintBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((b + i) & 0xff), 0x85ebca6b) >>> 0;
  }
  return `${bytes.length.toString(16)}:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export interface PrinterHttpOptions {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeout?: Duration.Duration;
  readonly operation: string;
  readonly printerId?: string;
  readonly maxBytes?: number;
}

function buildRequest(url: URL, options: PrinterHttpOptions): HttpClientRequest.HttpClientRequest {
  let req = HttpClientRequest.make(options.method ?? "GET")(url.toString());
  if (options.headers) {
    req = HttpClientRequest.setHeaders(req, options.headers);
  }
  if (options.body !== undefined) {
    req = HttpClientRequest.bodyText(
      req,
      options.body,
      options.headers?.["Content-Type"] ?? "application/json",
    );
  }
  return req;
}

function checkStatus(
  status: number,
  host: string,
  operation: string,
  printerId?: string,
): Effect.Effect<void, PrinterOperationError> {
  if (status >= 300 && status < 400) {
    return Effect.fail(
      new PrinterOperationError({
        operation,
        ...(printerId ? { printerId } : {}),
        reason: `Unexpected redirect (HTTP ${status}) from ${host}.`,
      }),
    );
  }
  if (status === 401 || status === 403) {
    return Effect.fail(
      new PrinterOperationError({
        operation,
        ...(printerId ? { printerId } : {}),
        reason: `Authentication rejected (HTTP ${status}) by ${host}.`,
      }),
    );
  }
  if (status < 200 || status >= 300) {
    return Effect.fail(
      new PrinterOperationError({
        operation,
        ...(printerId ? { printerId } : {}),
        reason: `Printer host ${host} returned HTTP ${status}.`,
      }),
    );
  }
  return Effect.void;
}

function sanitizeErrorMessage(error: unknown, host: string): string {
  if (isPrinterOperationError(error)) {
    return error.reason;
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutException" || error.name === "TimeoutError") {
      return `Timed out waiting for ${host}.`;
    }
    return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\?[^\s)]+/g, "");
  }
  return `Could not reach ${host}.`;
}

function readBoundedResponseBytes(
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
  url: URL,
  options: PrinterHttpOptions,
): Effect.Effect<Uint8Array, PrinterOperationError> {
  const declaredLength = Number(response.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return Effect.fail(
      new PrinterOperationError({
        operation: options.operation,
        ...(options.printerId ? { printerId: options.printerId } : {}),
        reason: `Printer response exceeded ${Math.round(maxBytes / (1024 * 1024))} MB limit.`,
      }),
    );
  }

  return response.stream.pipe(
    Stream.mapError(
      (error) =>
        new PrinterOperationError({
          operation: options.operation,
          ...(options.printerId ? { printerId: options.printerId } : {}),
          reason: sanitizeErrorMessage(error, url.host),
        }),
    ),
    Stream.runFoldEffect<
      { readonly chunks: Array<Uint8Array>; total: number },
      Uint8Array,
      PrinterOperationError,
      never
    >(
      () => ({ chunks: [], total: 0 }),
      (acc, chunk) => {
        const nextTotal = acc.total + chunk.byteLength;
        if (nextTotal > maxBytes) {
          return Effect.fail(
            new PrinterOperationError({
              operation: options.operation,
              ...(options.printerId ? { printerId: options.printerId } : {}),
              reason: `Printer response exceeded ${Math.round(maxBytes / (1024 * 1024))} MB limit.`,
            }),
          );
        }
        acc.chunks.push(chunk);
        acc.total = nextTotal;
        return Effect.succeed(acc);
      },
    ),
    Effect.map(({ chunks, total }) => {
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged;
    }),
  );
}

const executeBoundedRequest = Effect.fn("PrinterUrlGuard.executeBoundedRequest")(function* (
  url: URL,
  options: PrinterHttpOptions,
  defaultTimeout: Duration.Duration,
  defaultMaxBytes: number,
): Effect.fn.Return<
  { readonly bytes: Uint8Array; readonly contentType: string },
  PrinterOperationError,
  HttpClient.HttpClient
> {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const maxBytes = options.maxBytes ?? defaultMaxBytes;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const bareHost = normalizeHost(url.hostname);
      const pinnedMap = yield* Effect.serviceOption(PrinterPinnedAddresses);
      const activePin = Option.isSome(pinnedMap) ? pinnedMap.value.get(bareHost) : undefined;
      const isReadOnlyGet = (options.method ?? "GET") === "GET";
      const resolvedAddresses = yield* resolveCheckedAddresses(
        url,
        options.operation,
        options.printerId,
      );
      const guard = yield* Effect.serviceOption(PrinterRequestGuard);

      const executeOnce = Effect.fn("PrinterUrlGuard.executeOnce")(function* (
        targetAddresses: ReadonlyArray<ResolvedAddress> | null,
      ) {
        const pinned =
          targetAddresses !== null
            ? yield* acquirePinnedDispatcher(targetAddresses, options.operation, options.printerId)
            : undefined;
        if (Option.isSome(guard)) {
          yield* guard.value();
        }
        const requestInit: globalThis.RequestInit = {
          redirect: "manual",
          ...(pinned
            ? {
                dispatcher: pinned.agent as unknown as NonNullable<
                  globalThis.RequestInit["dispatcher"]
                >,
              }
            : {}),
        };
        const execute = client
          .execute(buildRequest(url, options))
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, requestInit));
        return yield* pinned
          ? Effect.provideService(execute, FetchHttpClient.Fetch, pinned.fetch)
          : execute;
      });

      let response: HttpClientResponse.HttpClientResponse;
      if (activePin && resolvedAddresses !== null && resolvedAddresses.length > 0) {
        if (activePin.pinned !== null) {
          response = yield* executeOnce([activePin.pinned]);
        } else if (isReadOnlyGet) {
          let lastError: unknown = null;
          let matched: HttpClientResponse.HttpClientResponse | undefined;
          const totalTimeoutMs = Duration.toMillis(options.timeout ?? defaultTimeout);
          const candidateCount = activePin.candidates.length;
          // Bound each candidate attempt inside the overall deadline so one black-holed IPv6 route
          // still leaves budget for a healthy IPv4 fallback.
          const perCandidateTimeout =
            candidateCount > 1
              ? Duration.millis(
                  Math.max(500, Math.min(2500, Math.floor(totalTimeoutMs / candidateCount))),
                )
              : undefined;
          for (let index = 0; index < candidateCount; index += 1) {
            const candidate = activePin.candidates[index]!;
            const attemptEffect =
              perCandidateTimeout !== undefined && index < candidateCount - 1
                ? executeOnce([candidate]).pipe(Effect.timeout(perCandidateTimeout))
                : executeOnce([candidate]);
            const attempt = yield* Effect.result(attemptEffect);
            if (attempt._tag === "Success") {
              activePin.pinned = candidate;
              matched = attempt.success;
              break;
            }
            if (isPrinterOperationError(attempt.failure)) {
              return yield* attempt.failure;
            }
            lastError = attempt.failure;
          }
          if (!matched) {
            return yield* Effect.fail(lastError ?? new Error(`Could not reach ${url.host}.`));
          }
          response = matched;
        } else {
          // Never retry a write on a second IP address.
          const primary = activePin.candidates[0]!;
          activePin.pinned = primary;
          response = yield* executeOnce([primary]);
        }
      } else {
        response = yield* executeOnce(resolvedAddresses);
      }

      yield* checkStatus(response.status, url.host, options.operation, options.printerId);
      const bytes = yield* readBoundedResponseBytes(response, maxBytes, url, options);
      const contentType = response.headers["content-type"] ?? "application/octet-stream";
      return { bytes, contentType };
    }),
  ).pipe(
    Effect.timeout(options.timeout ?? defaultTimeout),
    Effect.mapError((error) =>
      isPrinterOperationError(error)
        ? error
        : new PrinterOperationError({
            operation: options.operation,
            ...(options.printerId ? { printerId: options.printerId } : {}),
            reason: sanitizeErrorMessage(error, url.host),
          }),
    ),
  );
});

const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeEffect(UnknownJsonString);

export interface PrinterJsonOptions extends PrinterHttpOptions {
  readonly expectedType?: "object" | "array";
}

export const fetchPrinterJson = Effect.fn("PrinterUrlGuard.fetchPrinterJson")(function* <
  T = unknown,
>(
  url: URL,
  options: PrinterJsonOptions,
): Effect.fn.Return<T, PrinterOperationError, HttpClient.HttpClient> {
  const { bytes } = yield* executeBoundedRequest(url, options, DEFAULT_TIMEOUT, MAX_TEXT_BYTES);
  const parsed = yield* decodeUnknownJson(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(
      (error) =>
        new PrinterOperationError({
          operation: options.operation,
          ...(options.printerId ? { printerId: options.printerId } : {}),
          reason: sanitizeErrorMessage(error, url.host),
        }),
    ),
  );
  const expectedType = options.expectedType ?? "object";
  const validShape =
    expectedType === "array"
      ? Array.isArray(parsed)
      : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (!validShape) {
    return yield* new PrinterOperationError({
      operation: options.operation,
      ...(options.printerId ? { printerId: options.printerId } : {}),
      reason: `Printer host ${url.host} returned an unexpected JSON ${expectedType === "array" ? "array" : "object"} payload.`,
    });
  }
  return parsed as T;
});

export const fetchPrinterText = Effect.fn("PrinterUrlGuard.fetchPrinterText")(function* (
  url: URL,
  options: PrinterHttpOptions,
): Effect.fn.Return<string, PrinterOperationError, HttpClient.HttpClient> {
  const { bytes } = yield* executeBoundedRequest(url, options, DEFAULT_TIMEOUT, MAX_TEXT_BYTES);
  return new TextDecoder().decode(bytes);
});

export const fetchPrinterBinary = Effect.fn("PrinterUrlGuard.fetchPrinterBinary")(function* (
  url: URL,
  options: PrinterHttpOptions,
): Effect.fn.Return<
  { readonly bytes: Uint8Array; readonly contentType: string },
  PrinterOperationError,
  HttpClient.HttpClient
> {
  const { bytes, contentType } = yield* executeBoundedRequest(
    url,
    options,
    MEDIA_TIMEOUT,
    MAX_MEDIA_BYTES,
  );
  if (bytes.byteLength === 0) {
    return yield* new PrinterOperationError({
      operation: options.operation,
      ...(options.printerId ? { printerId: options.printerId } : {}),
      reason: "Printer returned an empty media frame.",
    });
  }
  return { bytes, contentType };
});
