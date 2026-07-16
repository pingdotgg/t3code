// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";

import type { HttpClientCapability, HttpClientRequestInput } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  defaultLookup,
  OutboundUrlError,
  OutboundUrlValidator,
  type ResolvedAddress,
  type UrlValidatorDeps,
} from "../OutboundUrlValidator.ts";
import { readHttpResponseBytesCapped } from "../readHttpResponseBytesCapped.ts";

const DEFAULT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const HARD_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_BODY_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_TIMEOUT_MS = 120_000;
// Reject header names/values carrying CR/LF or other control chars so a plugin
// forwarding attacker-influenced data cannot inject/smuggle a second header.
const hasControlChars = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

export class HttpEgressBlockedError extends Schema.TaggedErrorClass<HttpEgressBlockedError>()(
  "HttpEgressBlockedError",
  {
    host: Schema.String,
    reason: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `HTTP egress to '${this.host}' is blocked: ${this.reason}`;
  }
}

export class HttpClientError extends Schema.TaggedErrorClass<HttpClientError>()("HttpClientError", {
  host: Schema.String,
  reason: Schema.String,
  data: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    return `HTTP request to '${this.host}' failed: ${this.reason}`;
  }
}

const isHttpClientError = Schema.is(HttpClientError);

export interface PluginPinnedHttpRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
  readonly timeoutMs: number;
  /**
   * EVERY validated address for the host, not just the first.
   *
   * The validator already checked all of them and failed the resolve if any was
   * disallowed, so pinning the connection to this whole set is exactly as safe as
   * pinning to one — and it lets Node's Happy Eyeballs fall back when the first
   * record (say an unreachable IPv6) is down but a later one (IPv4) works. Pinning to
   * `addresses[0]` alone turned a reachable dual-stack host into a failed request.
   */
  readonly addresses: ReadonlyArray<ResolvedAddress>;
}

export type PluginHttpClientTransport = (
  request: PluginPinnedHttpRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>;

type HttpClientJsonRequestInput = Omit<HttpClientRequestInput, "body"> & {
  readonly body?: unknown;
};
type HttpClientGetJsonInput = Omit<HttpClientRequestInput, "method" | "url" | "body">;

export class PluginHttpClientTransportService extends Context.Service<
  PluginHttpClientTransportService,
  PluginHttpClientTransport
>()("t3/plugins/capabilities/HttpClientCapability/PluginHttpClientTransportService") {}

const bodyToBytes = (body: HttpClientRequestInput["body"]): Uint8Array | null => {
  if (body === undefined) return null;
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
};

const clampPositiveInteger = (value: number | undefined, fallback: number, hardMax: number) => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), hardMax);
};

const hostForMessage = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname || rawUrl;
  } catch {
    return rawUrl;
  }
};

const validateHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
  host: string,
): Effect.Effect<Readonly<Record<string, string>>, HttpClientError> => {
  if (!headers) return Effect.succeed({});
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (hasControlChars(name) || hasControlChars(value)) {
      return Effect.fail(
        new HttpClientError({ host, reason: "request header contains control characters" }),
      );
    }
    normalized[name] = value;
  }
  return Effect.succeed(normalized);
};

function nodeHeadersToWebHeaders(headers: NodeHttp.IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(name, item);
    } else {
      webHeaders.set(name, value);
    }
  }
  return webHeaders;
}

/**
 * Statuses that MUST NOT carry a body. The `Response` constructor throws a TypeError
 * if given one, and `makeResponse` runs inside Node's response callback — so the throw
 * escapes the enclosing Promise entirely: neither `resolve` nor `reject` fires, and an
 * uncaught exception takes the server down instead of failing the plugin's request.
 * A plugin GET against any endpoint that 204s was enough.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function makeResponse(input: {
  readonly url: URL;
  readonly method: string;
  readonly response: NodeHttp.IncomingMessage;
}): HttpClientResponse.HttpClientResponse {
  const request = HttpClientRequest.make(input.method as "GET")(input.url.toString());
  const status = input.response.statusCode ?? 0;
  let body: ReadableStream<Uint8Array> | null = null;
  if (NULL_BODY_STATUSES.has(status)) {
    // No body to hand over, but the socket still has to be released — an
    // unconsumed IncomingMessage keeps the pinned connection occupied until it
    // times out.
    input.response.resume();
  } else {
    body = NodeStream.Readable.toWeb(input.response) as ReadableStream<Uint8Array>;
  }
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: nodeHeadersToWebHeaders(input.response.headers),
    }),
  );
}

const nodePinnedTransport: PluginHttpClientTransport = (input) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<HttpClientResponse.HttpClientResponse>((resolve, reject) => {
        const client = input.url.protocol === "http:" ? NodeHttp : NodeHttps;
        const request = client.request(
          input.url,
          {
            method: input.method,
            headers: input.headers,
            timeout: input.timeoutMs,
            // Pin the connection to the validator-resolved address. Node's
            // net layer calls this with `all: true` when autoSelectFamily
            // (Happy Eyeballs, default since Node 20) is active and then
            // expects an ARRAY of addresses; the scalar form is only used
            // when `all` is unset.
            lookup: (_hostname, options, callback) => {
              if (options.all) {
                callback(
                  null,
                  input.addresses.map((address) => ({
                    address: address.address,
                    family: address.family,
                  })),
                );
              } else {
                // Scalar form (autoSelectFamily off): only the first is offered, but
                // it is still a VALIDATED address — no fallback, but no bypass.
                const first = input.addresses[0]!;
                callback(null, first.address, first.family);
              }
            },
          },
          (response) => {
            resolve(makeResponse({ url: input.url, method: input.method, response }));
          },
        );
        // Fiber interruption (e.g. the caller's wall-clock deadline in
        // `request` below) aborts this signal; tear the socket down so an
        // interrupted request cannot keep the connection open.
        signal.addEventListener("abort", () => {
          request.destroy(new Error("aborted"));
        });
        request.on("timeout", () => {
          request.destroy(new Error("timeout"));
        });
        request.on("error", reject);
        if (input.body) {
          request.write(Buffer.from(input.body));
        }
        request.end();
      }),
    catch: (cause) =>
      // Derive the wrapper message from a stable structural reason only; the real
      // transport error is preserved in `data.cause`. Echoing cause.message would
      // leak underlying (possibly attacker-influenced) transport text into the
      // wrapper message, unlike the other HttpClientError sites in this file which
      // already use stable reasons.
      new HttpClientError({
        host: input.url.hostname,
        reason: "transport request failed",
        data: { cause },
      }),
  });

export const PluginHttpClientTransportLive = Layer.succeed(
  PluginHttpClientTransportService,
  nodePinnedTransport,
);

const parseJson = <A>(bytes: Uint8Array, host: string): Effect.Effect<A, HttpClientError> =>
  Effect.try({
    // @effect-diagnostics-next-line preferSchemaOverJson:off -- SDK convenience wrapper returns caller-typed JSON.
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as A,
    catch: (cause) =>
      new HttpClientError({
        host,
        reason: "response body is not valid JSON",
        data: { cause },
      }),
  });

export function makeHttpClientCapability(input?: {
  readonly lookup?: UrlValidatorDeps["lookup"] | undefined;
  readonly transport?: PluginHttpClientTransport | undefined;
}): HttpClientCapability {
  const lookup = input?.lookup ?? defaultLookup;
  const transport = input?.transport ?? nodePinnedTransport;

  const request: HttpClientCapability["request"] = (requestInput) =>
    Effect.gen(function* () {
      const host = hostForMessage(requestInput.url);
      const resolved = yield* OutboundUrlValidator.resolve(requestInput.url, {
        lookup,
        allowHttpLoopback: process.env.T3_PLUGIN_DEV === "1",
      }).pipe(
        Effect.mapError(
          (error: OutboundUrlError) =>
            new HttpEgressBlockedError({
              host,
              reason: error.reason,
              data: { cause: error },
            }),
        ),
      );
      const headers = yield* validateHeaders(requestInput.headers, host);
      const requestBody = bodyToBytes(requestInput.body);
      if (requestBody !== null && requestBody.byteLength > REQUEST_BODY_MAX_BYTES) {
        return yield* new HttpClientError({
          host,
          reason: "request body exceeded the size limit",
          data: { limit: REQUEST_BODY_MAX_BYTES, actual: requestBody.byteLength },
        });
      }
      const maxResponseBytes = clampPositiveInteger(
        requestInput.maxResponseBytes,
        DEFAULT_RESPONSE_MAX_BYTES,
        HARD_RESPONSE_MAX_BYTES,
      );
      const timeoutMs = clampPositiveInteger(
        requestInput.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        HARD_TIMEOUT_MS,
      );
      // Hard end-to-end deadline around transport + body read. The Node
      // `timeout` option passed to the transport only bounds SOCKET
      // INACTIVITY (it resets on every byte), so a slow-drip server sending
      // one byte per idle window could otherwise hold the socket and buffer
      // indefinitely while staying under the byte cap. Interruption from the
      // deadline aborts the transport's signal, destroying the socket.
      return yield* Effect.gen(function* () {
        const response = yield* transport({
          url: resolved.url,
          method: requestInput.method.toUpperCase(),
          headers,
          body: requestBody,
          timeoutMs,
          addresses: resolved.addresses,
        });
        // A null-body status has no body to read, and asking for one fails: the
        // Response was constructed with `null` (the constructor rejects a body for
        // these, even an empty stream), so its `.stream` errors rather than ending.
        // Hand back zero bytes, which is what 204/205/304 mean.
        const body = NULL_BODY_STATUSES.has(response.status)
          ? new Uint8Array(0)
          : yield* readHttpResponseBytesCapped({
              response,
              maxBytes: maxResponseBytes,
              tooLarge: (actual) =>
                new HttpClientError({
                  host: resolved.url.hostname,
                  reason: "response body exceeded the size limit",
                  data: { limit: maxResponseBytes, actual },
                }),
              readFailed: (cause) =>
                isHttpClientError(cause)
                  ? cause
                  : new HttpClientError({
                      host: resolved.url.hostname,
                      reason: "failed to read response body",
                      data: { cause },
                    }),
            });
        return {
          status: response.status,
          headers: response.headers,
          body,
        };
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(timeoutMs),
          orElse: () =>
            new HttpClientError({
              host: resolved.url.hostname,
              reason: "request exceeded the time limit",
              data: { timeoutMs },
            }),
        }),
      );
    });

  return {
    request,
    requestJson: <A = unknown>(jsonInput: HttpClientJsonRequestInput) =>
      Effect.gen(function* () {
        const { body: jsonBody, ...requestRest } = jsonInput;
        let body: string | undefined;
        if (jsonBody !== undefined) {
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- SDK convenience wrapper accepts arbitrary JSON payloads.
          body = JSON.stringify(jsonBody);
        }
        const response = yield* request({
          ...requestRest,
          ...(body === undefined ? {} : { body }),
          headers: {
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...jsonInput.headers,
          },
        });
        return yield* parseJson<A>(response.body, hostForMessage(jsonInput.url));
      }),
    getJson: <A = unknown>(url: string, jsonInput: HttpClientGetJsonInput = {}) =>
      request({
        ...jsonInput,
        method: "GET",
        url,
        headers: {
          accept: "application/json",
          ...jsonInput.headers,
        },
      }).pipe(Effect.flatMap((response) => parseJson<A>(response.body, hostForMessage(url)))),
  };
}
