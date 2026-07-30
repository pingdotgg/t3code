import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";
import type { HttpEffect } from "./Http.ts";

export type Rpc<Shape> = {
  "~alchemy/rpc": Shape;
};

/**
 * Recover the user's RPC `Shape` from any of the forms a caller might pass
 * to {@link toRpcAsync}:
 *
 *   - the Worker class value's type, e.g. `typeof Backend`, which extends
 *     `Effect.Effect<Worker & Rpc<Shape>, …>`
 *   - the unwrapped `Worker & Rpc<Shape>` type
 *   - a bare `Shape` (when the caller types it explicitly)
 */
export declare namespace Rpc {
  export type Shape<W> =
    W extends Effect.Effect<infer R, any, any>
      ? R extends Rpc<infer Shape>
        ? Shape
        : R
      : W extends Rpc<infer Shape>
        ? Shape
        : W;
}

// ---------------------------------------------------------------------------
// Wire protocol shared by every transport (native Cloudflare JSRPC and the
// plain-`fetch` transport below). The marker tags travel as structured-clone
// objects over JSRPC, or as NDJSON / response headers over `fetch`.
// ---------------------------------------------------------------------------

export const StreamTag = "~alchemy/rpc/stream";
export const ErrorTag = "~alchemy/rpc/error";
export const StreamErrorTag = "~alchemy/rpc/stream-error";

export type StreamEncoding = "bytes" | "jsonl";

export type RpcStreamEnvelope = {
  _tag: typeof StreamTag;
  encoding: StreamEncoding;
  body: ReadableStream<Uint8Array>;
};

export type RpcErrorEnvelope = {
  _tag: typeof ErrorTag;
  error: unknown;
};

export type RpcStreamErrorMarker = {
  _tag: typeof StreamErrorTag;
  error: unknown;
};

export class RpcDecodeError extends Data.TaggedError("RpcDecodeError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

export class RpcCallError extends Data.TaggedError("RpcCallError")<{
  readonly method: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `RPC call to "${this.method}" failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

export class RpcRemoteStreamError extends Data.TaggedError(
  "RpcRemoteStreamError",
)<{
  readonly error: unknown;
}> {}

export const isRpcStreamErrorMarker = (
  value: unknown,
): value is RpcStreamErrorMarker =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === StreamErrorTag &&
  "error" in value;

export const isRpcErrorEnvelope = (value: unknown): value is RpcErrorEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === ErrorTag &&
  "error" in value;

export const isRpcStreamEnvelope = (
  value: unknown,
): value is RpcStreamEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === StreamTag &&
  "encoding" in value &&
  (value.encoding === "bytes" || value.encoding === "jsonl") &&
  "body" in value &&
  value.body instanceof ReadableStream;

/**
 * Normalize an error value into a plain, structured-clone-safe object.
 * Tagged errors keep `_tag` and all own enumerable fields.
 * Plain `Error` instances keep `name`, `message`, and `stack`.
 */
export const encodeRpcError = (error: unknown): unknown => {
  if (error === null || error === undefined) return error;
  if (typeof error !== "object") return error;

  const obj = error as Record<string, unknown>;
  if ("_tag" in obj && typeof obj._tag === "string") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = obj[key];
    }
    if (error instanceof Error && !("message" in out)) {
      out.message = (error as Error).message;
    }
    return out;
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  return error;
};

// ---------------------------------------------------------------------------
// Stream decoding (client side): turn a wire byte-stream into a typed Effect
// `Stream`, lifting embedded error markers into the error channel.
// ---------------------------------------------------------------------------

/**
 * Decode a wire byte stream into the original values. `bytes` streams pass
 * through untouched; `jsonl` streams are split per-line, JSON-parsed, and any
 * embedded {@link RpcStreamErrorMarker} is lifted into the error channel.
 */
export const decodeRpcByteStream = <E>(
  bytes: Stream.Stream<Uint8Array, E>,
  encoding: StreamEncoding,
): Stream.Stream<any, E | RpcDecodeError | RpcRemoteStreamError> => {
  if (encoding === "bytes") {
    return bytes;
  }
  return bytes.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect((line) =>
      Effect.try({
        try: () => JSON.parse(line),
        catch: (cause) => new RpcDecodeError({ cause }),
      }),
    ),
    Stream.flatMap((value) =>
      isRpcStreamErrorMarker(value)
        ? Stream.fail(new RpcRemoteStreamError({ error: value.error }))
        : Stream.succeed(value),
    ),
  );
};

export const fromRpcReadableStream = (
  body: ReadableStream<Uint8Array>,
  encoding: StreamEncoding,
): Stream.Stream<
  any,
  Socket.SocketError | RpcDecodeError | RpcRemoteStreamError
> =>
  decodeRpcByteStream(
    Stream.fromReadableStream({
      evaluate: () => body,
      onError: (cause) =>
        Socket.isSocketError(cause)
          ? cause
          : new Socket.SocketError({
              reason: new Socket.SocketReadError({ cause }),
            }),
    }),
    encoding,
  );

export const fromRpcStreamEnvelope = (
  envelope: RpcStreamEnvelope,
): Stream.Stream<
  any,
  Socket.SocketError | RpcDecodeError | RpcRemoteStreamError
> => fromRpcReadableStream(envelope.body, envelope.encoding);

export const decodeRpcValue = (value: unknown) => {
  if (isRpcStreamEnvelope(value)) {
    return fromRpcReadableStream(value.body, value.encoding);
  }

  if (value instanceof ReadableStream) {
    return fromRpcReadableStream(value, "bytes");
  }

  return value;
};

/**
 * Decode an RPC return value, lifting error envelopes into the Effect
 * error channel so that remote `Effect.fail(...)` values are recoverable.
 */
export const decodeRpcResult = (
  value: unknown,
): Effect.Effect<unknown, unknown> => {
  if (isRpcErrorEnvelope(value)) {
    return Effect.fail(value.error);
  }
  return Effect.succeed(decodeRpcValue(value));
};

// ---------------------------------------------------------------------------
// Stream encoding (server side): turn a typed Effect `Stream` into a wire
// byte stream, embedding any failure as a trailing error marker.
// ---------------------------------------------------------------------------

const encodeStreamErrorMarker = (cause: Cause.Cause<unknown>): string => {
  const failReason = cause.reasons.find(Cause.isFailReason);
  const error = failReason ? encodeRpcError(failReason.error) : undefined;
  return (
    JSON.stringify({
      _tag: StreamErrorTag,
      error,
    } satisfies RpcStreamErrorMarker) + "\n"
  );
};

const appendStreamErrors = <R>(s: Stream.Stream<string, unknown, R>) =>
  s.pipe(
    Stream.catchCause((cause) =>
      Stream.succeed(encodeStreamErrorMarker(cause)),
    ),
  );

export const toRpcStream = (stream: Stream.Stream<any, any, any>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const [head, rest] = yield* Stream.peel(stream, Sink.head());

      if (Option.isSome(head) && head.value instanceof Uint8Array) {
        return {
          _tag: StreamTag,
          encoding: "bytes",
          body: Stream.toReadableStream(
            rest.pipe(Stream.prepend([head.value])),
          ),
        } satisfies RpcStreamEnvelope;
      }

      const body = Option.isSome(head)
        ? rest.pipe(Stream.prepend([head.value]))
        : rest;

      return {
        _tag: StreamTag,
        encoding: "jsonl",
        body: Stream.toReadableStream(
          appendStreamErrors(
            body.pipe(Stream.map((value) => JSON.stringify(value) + "\n")),
          ).pipe(Stream.encodeText),
        ),
      } satisfies RpcStreamEnvelope;
    }),
  ).pipe(
    Effect.catchCause((cause) => {
      const failReason = cause.reasons.find(Cause.isFailReason);
      if (failReason) {
        return Effect.succeed({
          _tag: StreamTag,
          encoding: "jsonl",
          body: Stream.toReadableStream(
            Stream.succeed(encodeStreamErrorMarker(cause)).pipe(
              Stream.encodeText,
            ),
          ),
        } satisfies RpcStreamEnvelope);
      }
      return Effect.die(Cause.squash(cause));
    }),
  );

// ---------------------------------------------------------------------------
// `fetch`-transport stream codec. Unlike the JSRPC path above (which can peel
// to pick a raw-`bytes` vs `jsonl` encoding because its `ReadableStream` body
// is materialized eagerly), an HTTP response body is consumed lazily AFTER the
// handler returns — so peeling here would tie the source to the handler scope
// and truncate the body to its first element once that scope closes. Instead
// this codec is uniformly NDJSON and FULLY LAZY (no peel, no scope): each line
// is a JSON value, `Uint8Array` chunks are tagged + base64-encoded so binary
// streams round-trip, and a failure is appended as a trailing error marker.
// ---------------------------------------------------------------------------

const BytesTag = "~alchemy/rpc/bytes";

type RpcBytesChunk = { _tag: typeof BytesTag; b64: string };

const isRpcBytesChunk = (value: unknown): value is RpcBytesChunk =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === BytesTag &&
  "b64" in value;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/**
 * Encode a `Stream` as a lazy NDJSON byte stream for an HTTP response body.
 * No peeking, so nothing is held open across the handler→body-streaming
 * boundary. `Uint8Array` elements are tagged + base64-encoded; a source
 * failure is appended as a trailing {@link RpcStreamErrorMarker}.
 */
export const encodeRpcResponseStream = (
  stream: Stream.Stream<any, any, any>,
): Stream.Stream<Uint8Array, never, any> =>
  appendStreamErrors(
    stream.pipe(
      Stream.map((value) =>
        value instanceof Uint8Array
          ? JSON.stringify({ _tag: BytesTag, b64: toBase64(value) }) + "\n"
          : JSON.stringify(value) + "\n",
      ),
    ),
  ).pipe(Stream.encodeText);

/**
 * Decode an NDJSON byte stream produced by {@link encodeRpcResponseStream}:
 * tagged byte chunks become `Uint8Array`, a {@link RpcStreamErrorMarker} is
 * lifted into the error channel, everything else is the decoded JSON value.
 */
export const decodeRpcResponseStream = <E>(
  bytes: Stream.Stream<Uint8Array, E>,
): Stream.Stream<any, E | RpcDecodeError | RpcRemoteStreamError> =>
  bytes.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect((line) =>
      Effect.try({
        try: () => JSON.parse(line),
        catch: (cause) => new RpcDecodeError({ cause }),
      }),
    ),
    Stream.flatMap((value) =>
      isRpcStreamErrorMarker(value)
        ? Stream.fail(new RpcRemoteStreamError({ error: value.error }))
        : Stream.succeed(
            isRpcBytesChunk(value) ? fromBase64(value.b64) : value,
          ),
    ),
  );

// ---------------------------------------------------------------------------
// `asEffectOrStream`: a single value usable as BOTH an `Effect` and a `Stream`.
// ---------------------------------------------------------------------------

// Effect's internal Stream brand. `Stream.isStream` recognises a value by
// this property and reads its `channel`. An RPC stub method can't know
// synchronously whether the remote method returns a value or a `Stream`
// (the call is async), yet its declared type mirrors the remote `Shape`
// verbatim — value methods are typed `Effect<A>`, streaming methods `Stream<A>`.
// We satisfy BOTH by handing back the call `Effect` augmented with the Stream
// brand + channel, so the single return value can be `yield*`-ed / `.pipe`d as
// an Effect (value methods, e.g. `stub.put(k, v).pipe(Effect.orDie)`) AND piped
// through `Stream.*` combinators (streaming methods, e.g.
// `stub.tick(n).pipe(Stream.map(...))`).
const StreamTypeId = "~effect/Stream";

export const asEffectOrStream = (
  call: Effect.Effect<unknown, unknown>,
): Effect.Effect<unknown, unknown> => {
  const streamForm = Stream.unwrap(
    Effect.map(call, (value) =>
      Stream.isStream(value) ? value : Stream.succeed(value),
    ),
  );
  return Object.assign(call, {
    [StreamTypeId]: (streamForm as any)[StreamTypeId],
    channel: (streamForm as any).channel,
  });
};

// ---------------------------------------------------------------------------
// `fetch` transport: a transport-agnostic RPC over plain HTTP. Each method is
// a `POST {RPC_PATH_PREFIX}{name}` whose request body is the JSON-encoded
// argument array; the response is either a JSON value, a JSON error envelope,
// or a streamed body (NDJSON / raw bytes) flagged by response headers.
// ---------------------------------------------------------------------------

/** Path prefix under which RPC methods are dispatched. */
export const RPC_PATH_PREFIX = "/__rpc__/";
/** Response header flag marking an NDJSON streamed body (vs a JSON value). */
export const RPC_STREAM_HEADER = "x-alchemy-rpc-stream";

/**
 * Build a typed RPC stub over a plain `fetch` transport. Any property that
 * isn't an own property of `base` is treated as a remote method: calling it
 * `POST`s `{baseUrl}{RPC_PATH_PREFIX}{name}` with the JSON-encoded arguments
 * and decodes the response into an {@link asEffectOrStream} value (so value
 * methods `yield*` as `Effect`s and streaming methods pipe as `Stream`s).
 */
export const makeFetchRpcStub = <Shape>(options: {
  readonly fetch: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  readonly baseUrl?: string;
  /** Own properties that take precedence over remote-method dispatch. */
  readonly base?: Record<string, unknown>;
}): Shape => {
  const baseUrl = options.baseUrl ?? "http://alchemy-rpc";
  const target: Record<string, unknown> = options.base ?? {};

  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop in obj) return obj[prop as keyof typeof obj];
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) =>
        asEffectOrStream(
          Effect.gen(function* () {
            const request = HttpClientRequest.post(
              `${baseUrl}${RPC_PATH_PREFIX}${encodeURIComponent(prop)}`,
            ).pipe(
              HttpClientRequest.bodyText(
                JSON.stringify(args),
                "application/json",
              ),
            );
            const response = yield* options
              .fetch(request)
              .pipe(
                Effect.mapError(
                  (cause) => new RpcCallError({ method: prop, cause }),
                ),
              );

            const headers = response.headers as Record<
              string,
              string | undefined
            >;
            if (headers[RPC_STREAM_HEADER] !== undefined) {
              return decodeRpcResponseStream(response.stream);
            }

            const value = yield* response.json.pipe(
              Effect.mapError(
                (cause) => new RpcCallError({ method: prop, cause }),
              ),
            );
            return yield* decodeRpcResult(value);
          }),
        );
    },
  }) as Shape;
};

/**
 * Serve the RPC methods on `shape` over the {@link RPC_PATH_PREFIX} route,
 * delegating every other request to `fallback`. The mirror of {@link
 * makeFetchRpcStub}: method arguments are read from the JSON request body, the
 * method is invoked, and the result is encoded as a JSON value, a JSON error
 * envelope, or a streamed body (flagged via {@link RPC_STREAM_HEADER}).
 */
export const serveRpc = <Req = never>(
  shape: Record<string, unknown>,
  fallback: HttpEffect<Req>,
): HttpEffect<Req> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const prefixAt = request.url.indexOf(RPC_PATH_PREFIX);
    if (prefixAt === -1) {
      return yield* fallback;
    }

    let name = request.url.slice(prefixAt + RPC_PATH_PREFIX.length);
    const queryAt = name.indexOf("?");
    if (queryAt !== -1) name = name.slice(0, queryAt);
    name = decodeURIComponent(name);

    const method = shape[name];
    if (typeof method !== "function") {
      return HttpServerResponse.text(`Unknown RPC method "${name}"`, {
        status: 404,
      });
    }

    const text = yield* request.text;
    // Keep arg-decode failures out of the handler's error channel — a
    // malformed argument payload is a client error, so answer 400.
    const argsResult = yield* Effect.result(
      Effect.try({
        try: () => (text.length > 0 ? (JSON.parse(text) as unknown[]) : []),
        catch: (cause) => new RpcDecodeError({ cause }),
      }),
    );
    if (Result.isFailure(argsResult)) {
      return HttpServerResponse.text(
        `Invalid RPC arguments for "${name}": ${argsResult.failure.message}`,
        { status: 400 },
      );
    }
    const args = argsResult.success;

    const invoked = (method as (...a: unknown[]) => unknown)(...args);

    // Fully-lazy NDJSON body: nothing is held open across the
    // handler→body-streaming boundary, so the stream isn't truncated. The
    // body's requirements are the shape method's phantom `R` (e.g.
    // `RuntimeContext`), satisfied by the surrounding runtime; erase it for
    // the response constructor.
    const streamResponse = (stream: Stream.Stream<unknown, unknown, unknown>) =>
      HttpServerResponse.stream(
        encodeRpcResponseStream(stream) as Stream.Stream<Uint8Array, never>,
        { headers: { [RPC_STREAM_HEADER]: "ndjson" } },
      );

    // A *genuine* `Stream` (not an Effect) is encoded directly. A nested-RPC
    // value built by {@link asEffectOrStream} is BOTH an Effect and a Stream —
    // it MUST be run as an effect (below), otherwise a forwarded value method
    // (e.g. a DO method returning `container.readObject(key)`) would be
    // mis-served as a stream envelope and decoded by the caller as a `Stream`
    // instead of the value.
    if (Stream.isStream(invoked) && !Effect.isEffect(invoked)) {
      return streamResponse(invoked);
    }

    const result = yield* Effect.result(
      invoked as Effect.Effect<unknown, unknown>,
    );
    if (Result.isSuccess(result)) {
      // The resolved value may itself be a `Stream` (e.g. a forwarded nested
      // *streaming* RPC, where the inner call resolves to a `Stream`) — encode
      // that as a stream body too.
      return Stream.isStream(result.success)
        ? streamResponse(result.success)
        : yield* HttpServerResponse.json(result.success ?? null);
    }
    return yield* HttpServerResponse.json({
      _tag: ErrorTag,
      error: encodeRpcError(result.failure),
    } satisfies RpcErrorEnvelope);
  });
