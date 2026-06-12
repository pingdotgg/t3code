/// <reference types="@cloudflare/workers-types" />

import type * as Effect from "effect/Effect";
import type { Redacted } from "effect/Redacted";
import type * as Stream from "effect/Stream";
import type { Rpc } from "../../Rpc.ts";
import type * as Cloudflare from "../index.ts";
import type { RpcErrorEnvelope, RpcStreamEnvelope } from "./Rpc.ts";
import type { Worker } from "./Worker.ts";

export type InferEnv<W> =
  W extends Effect.Effect<infer A, infer _E, infer _R>
    ? InferEnv<A>
    : W extends Worker<any>
      ? InferEnv<Exclude<W["Props"]["env"], undefined>>
      : {
          [k in keyof W]: GetBindingType<W[k]>;
        };

export type GetBindingType<T> =
  T extends Effect.Effect<infer A, infer _E, infer _R>
    ? GetBindingType<A>
    : T extends Cloudflare.Assets
      ? Service
      : T extends Rpc<infer Shape extends object>
        ? RpcWireShape<Shape> & Service
        : T extends Cloudflare.D1Database
          ? D1Database
          : T extends Cloudflare.R2Bucket
            ? R2Bucket
            : T extends Cloudflare.KVNamespace
              ? KVNamespace
              : T extends Cloudflare.Queue
                ? Queue<unknown>
                : T extends Cloudflare.AiGateway
                  ? Ai
                  : T extends Cloudflare.SendEmail
                    ? SendEmail
                    : T extends Cloudflare.AnalyticsEngineDataset
                      ? AnalyticsEngineDataset
                      : T extends Cloudflare.Artifacts
                        ? Artifacts
                        : T extends Cloudflare.RateLimit
                          ? RateLimit
                          : T extends Cloudflare.Images
                            ? ImagesBinding
                            : T extends Cloudflare.Browser
                              ? Fetcher
                              : T extends Cloudflare.Hyperdrive
                                ? Hyperdrive
                                : T extends Cloudflare.DynamicWorkerLoader
                                  ? Cloudflare.DynamicWorkerLoaderBinding
                                  : T extends Cloudflare.DurableObjectNamespaceLike
                                    ? DurableObjectNamespace<
                                        Exclude<T["Shape"], undefined>
                                      >
                                    : T extends Redacted<any>
                                      ? // redacteds are always stored as secret_text, so are always string
                                        // we JSON.stringify when not a Redacted<string>
                                        string
                                      : T;

/**
 * Cloudflare service-binding wire shape for an Effect-native Worker.
 *
 * Effect/Stream return values are encoded as envelopes on the wire (see
 * `RpcErrorEnvelope`, `RpcStreamEnvelope`), so the mapped types reflect what
 * the raw binding actually resolves to. `fetch` is dropped from the user
 * shape and re-introduced via `Service` so callers get the standard
 * `(input, init?) => Promise<Response>` signature.
 *
 * Use {@link toPromiseApi} to wrap a binding into a Promise<T>-flavored view
 * where envelopes are decoded for you.
 */
export type RpcWireShape<Shape> = {
  [K in keyof Shape as K extends "fetch" ? never : K]: Shape[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer T, any, any>
    ? (...args: A) => Promise<T | RpcErrorEnvelope>
    : Shape[K] extends (...args: infer A) => Stream.Stream<any, any, any>
      ? (...args: A) => Promise<RpcStreamEnvelope | RpcErrorEnvelope>
      : Shape[K] extends Effect.Effect<infer T, any, any>
        ? Promise<T | RpcErrorEnvelope>
        : Shape[K] extends Stream.Stream<any, any, any>
          ? Promise<RpcStreamEnvelope | RpcErrorEnvelope>
          : Shape[K] extends (...args: infer A) => infer R
            ? (...args: A) => Promise<Awaited<R>>
            : Promise<Shape[K]>;
};
