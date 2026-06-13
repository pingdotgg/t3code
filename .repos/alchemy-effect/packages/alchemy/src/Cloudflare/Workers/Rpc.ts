import type * as cf from "@cloudflare/workers-types";

import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  RpcClient,
  RpcSerialization,
  type Rpc,
  type RpcGroup,
} from "effect/unstable/rpc";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import { isYieldableEffect } from "../../Util/effect.ts";
import { fromCloudflareFetcher } from "../Fetcher.ts";

export const StreamTag = "~alchemy/rpc/stream";
export const ErrorTag = "~alchemy/rpc/error";
export const StreamErrorTag = "~alchemy/rpc/stream-error";

type StreamEncoding = "bytes" | "jsonl";

export type RpcStreamEnvelope = {
  _tag: typeof StreamTag;
  encoding: StreamEncoding;
  body: ReadableStream<Uint8Array>;
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

export type RpcErrorEnvelope = {
  _tag: typeof ErrorTag;
  error: unknown;
};

export type RpcStreamErrorMarker = {
  _tag: typeof StreamErrorTag;
  error: unknown;
};

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

export const fromRpcReadableStream = (
  body: ReadableStream<Uint8Array>,
  encoding: StreamEncoding,
): Stream.Stream<
  any,
  Socket.SocketError | RpcDecodeError | RpcRemoteStreamError
> => {
  const stream = Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) =>
      Socket.isSocketError(cause)
        ? cause
        : new Socket.SocketError({
            reason: new Socket.SocketReadError({ cause }),
          }),
  });

  if (encoding === "bytes") {
    return stream;
  }

  return stream.pipe(
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

/**
 * Wrap a Cloudflare service-binding stub (or an `Effect` that resolves
 * to one — useful when the stub depends on a service like
 * `WorkerEnvironment` that's only available at *exec* phase) into an
 * Effect-typed RPC client.
 *
 * `Service.fetch`/`Service.connect` are passed through eagerly when the
 * stub is already resolved; everything else is treated as an RPC method
 * whose dispatch is deferred until call time, so the user effect runs in
 * the right runtime layer (which is what `bindWorker` actually wants —
 * its methods are called at exec, even though it's *defined* at init).
 */
export const makeRpcStub = <Shape>(
  stubSource: unknown | Effect.Effect<unknown, never, never>,
): Shape => {
  const isLazy = isYieldableEffect(stubSource);
  const eagerFetcher = isLazy
    ? undefined
    : fromCloudflareFetcher(stubSource as cf.Fetcher);
  const proxyTarget: object = eagerFetcher ?? {};

  return new Proxy(proxyTarget, {
    get: (target: any, prop) => {
      if (!isLazy && prop in target) return target[prop];
      if (typeof prop !== "string" && typeof prop !== "symbol") {
        return target[prop];
      }
      return (...args: any[]) =>
        asEffectOrStream(
          Effect.gen(function* () {
            const stub = isLazy
              ? yield* stubSource as Effect.Effect<any>
              : stubSource;
            return yield* Effect.tryPromise({
              try: () => (stub as any)[prop](...args),
              catch: (cause) =>
                new RpcCallError({ method: String(prop), cause }),
            }).pipe(Effect.flatMap(decodeRpcResult));
          }),
        );
    },
  }) as Shape;
};

// Effect's internal Stream brand. `Stream.isStream` recognises a value by
// this property and reads its `channel`. A `makeRpcStub` method can't know
// synchronously whether the remote method returns a value or a `Stream`
// (the call is async), yet its declared type mirrors the DO `Shape`
// verbatim — value methods are typed `Effect<A>`, streaming methods `Stream<A>`.
// We satisfy BOTH by handing back the call `Effect` augmented with the Stream
// brand + channel, so the single return value can be `yield*`-ed / `.pipe`d as
// an Effect (value methods, e.g. `stub.put(k, v).pipe(Effect.orDie)`) AND piped
// through `Stream.*` combinators (streaming methods, e.g.
// `stub.tick(n).pipe(Stream.map(...))`).
const StreamTypeId = "~effect/Stream";

const asEffectOrStream = (
  call: Effect.Effect<unknown, unknown>,
): Effect.Effect<unknown, unknown> => {
  const streamForm = Stream.unwrap(
    Effect.map(call, (value) =>
      Stream.isStream(value) ? value : Stream.succeed(value),
    ),
  );
  return Object.assign(call, {
    [StreamTypeId]: streamForm[StreamTypeId],
    channel: streamForm.channel,
  });
};

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

const appendStreamErrors = (s: Stream.Stream<string, unknown>) =>
  s.pipe(
    Stream.catchCause((cause) =>
      Stream.succeed(encodeStreamErrorMarker(cause)),
    ),
  );

export const bindEffectRpc = <Rpcs extends Rpc.Any>(
  namespace: { readonly getByName: (id: string) => { readonly fetch: any } },
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: {
    /**
     * Override the rpc serialization layer. Defaults to NDJSON, which
     * is required when any rpc in the group is a streaming rpc.
     */
    readonly serialization?: Layer.Layer<RpcSerialization.RpcSerialization>;
  },
): {
  readonly getByName: (
    id: string,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>,
    never,
    Rpc.MiddlewareClient<Rpcs>
  >;
} => {
  const serialization = options?.serialization ?? RpcSerialization.layerNdjson;

  return {
    // Wrap the cached `RpcClient` Effect in a chainable Proxy so callers
    // can `yield* counter.getByName(id).method(args)` directly. The proxy
    // records the `.method(args)` ops and replays them against the
    // resolved client when the chain is yielded.
    getByName: Effect.fnUntraced(function* (id: string) {
      const httpClient = HttpClient.layerMergedContext(
        Effect.sync(() => {
          const stub = namespace.getByName(id);
          return HttpClient.make((request) => stub.fetch(request));
        }),
      );
      const protocol = RpcClient.layerProtocolHttp({
        url: "http://alchemy-rpc/",
      }).pipe(Layer.provide(serialization), Layer.provide(httpClient));
      return yield* RpcClient.make(group).pipe(Effect.provide(protocol));
    }) as any,
  };
};
