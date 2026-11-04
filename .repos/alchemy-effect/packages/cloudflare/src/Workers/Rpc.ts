import type * as cf from "@cloudflare/workers-types";
import {
  asEffectOrStream,
  decodeRpcResult,
  makeRpcErrorReviver,
  RpcCallError,
  type RpcErrorClass,
} from "alchemy/Rpc";
import { isYieldableEffect } from "alchemy/Util/effect";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization, type Rpc, type RpcGroup } from "effect/rpc";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as Schedule from "effect/Schedule";
import { fromCloudflareFetcher } from "../Fetcher.ts";
import { withRpcTraceContext } from "./internal/RpcTraceContext.ts";
import { isPlaceholderReset } from "./Placeholder.ts";

// The transport-agnostic RPC wire protocol (envelopes, error types, stream
// encode/decode, `asEffectOrStream`, and the plain-`fetch` client/server) now
// lives in `src/Rpc.ts` so non-Cloudflare runtimes (e.g. Containers) can reuse
// it. Re-export it here so existing `Cloudflare.*` consumers keep working.
export * from "alchemy/Rpc";

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
  stubSource: unknown,
  options?: {
    /**
     * Declared error classes (see {@link RpcErrorClass}): failed method
     * results whose `_tag` matches one are reconstructed as real class
     * instances instead of the plain objects RPC serialization produces.
     */
    readonly errors?: ReadonlyArray<RpcErrorClass> | undefined;
    /**
     * Append the caller's trace context to every call's arguments. Only for
     * a callee known to strip it again — a Durable Object class bridged by
     * the same bundle; anything else would get an extra argument.
     */
    readonly traceContext?: boolean | undefined;
  },
): Shape => {
  const isLazy = isYieldableEffect(stubSource);
  const eagerFetcher = isLazy ? undefined : fromCloudflareFetcher(stubSource as cf.Fetcher);
  const proxyTarget: object = eagerFetcher ?? {};
  const revive = makeRpcErrorReviver(options?.errors);

  return new Proxy(proxyTarget, {
    get: (target: any, prop) => {
      if (!isLazy && prop in target) return target[prop];
      if (typeof prop !== "string" && typeof prop !== "symbol") {
        return target[prop];
      }
      return (...args: any[]) =>
        asEffectOrStream(
          Effect.gen(function* () {
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- untyped lazy stub source
            const stub = isLazy ? yield* stubSource as Effect.Effect<any> : stubSource;
            // The callee parents its spans on the caller's, like `traceparent`
            // does for a `fetch` into the object.
            const callArgs = options?.traceContext ? yield* withRpcTraceContext(args) : args;
            return yield* Effect.tryPromise({
              try: () => (stub as any)[prop](...callArgs),
              catch: (cause) => new RpcCallError({ method: String(prop), cause }),
            }).pipe(
              // Right after a deploy, an object can still start on the
              // placeholder script, which runs none of the real code and
              // resets itself so the next call gets the deployed code. The
              // new code can take a while to reach every edge (~35s here).
              Effect.retry({
                while: (error) => isPlaceholderReset(error.cause),
                schedule: Schedule.min([
                  Schedule.exponential("200 millis"),
                  Schedule.spaced("2 seconds"),
                ]),
                times: 20,
              }),
              Effect.flatMap((value) => decodeRpcResult(value, revive)),
            );
          }),
        );
    },
  }) as Shape;
};

export const bindEffectRpc = <Rpcs extends Rpc.Any>(
  namespace: {
    readonly getByName: (
      id: string,
      options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
    ) => { readonly fetch: any };
  },
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
    options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
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
    getByName: Effect.fn(function* (
      id: string,
      options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
    ) {
      const httpClient = HttpClient.layerMergedContext(
        Effect.sync(() => {
          const stub = namespace.getByName(id, options);
          return HttpClient.make((request) => stub.fetch(request));
        }),
      );
      const protocol = RpcClient.layerProtocolHttp({ url: "http://alchemy-rpc/" }).pipe(
        Layer.provide(serialization),
        Layer.provide(httpClient),
      );
      return yield* RpcClient.make(group).pipe(Effect.provide(protocol));
    }) as any,
  };
};
