/// <reference types="@cloudflare/workers-types" />

import type * as Effect from "effect/Effect";
import type { Redacted } from "effect/Redacted";
import type * as Stream from "effect/Stream";
import type { Rpc } from "../../Rpc.ts";
import type { WorkflowLike } from "../Workflows/Workflow.ts";
// NOTE: import the service modules directly rather than `import * as Cloudflare
// from "../index.ts"`. Importing the whole Cloudflare barrel here creates a
// circular re-export when the barrel does `export * from "./Workers/index.ts"`
// (the barrel must enumerate this module, which imports the barrel back), which
// collapses inference of the large `providers()` collection to `unknown`.
import type * as AI from "../AI/index.ts";
import type * as AnalyticsEngine from "../AnalyticsEngine/index.ts";
import type * as ArtifactsNs from "../Artifacts/index.ts";
import type * as D1 from "../D1/index.ts";
import type * as Email from "../Email/index.ts";
import type * as FlagshipNs from "../Flagship/index.ts";
import type * as HyperdriveNs from "../Hyperdrive/index.ts";
import type * as ImagesNs from "../Images/index.ts";
import type * as KV from "../KV/index.ts";
import type * as Queues from "../Queues/index.ts";
import type * as R2 from "../R2/index.ts";
import type { DispatchNamespace as DispatchNamespaceResource } from "../WorkersForPlatforms/DispatchNamespace.ts";
import type { AIBinding } from "./AIBinding.ts";
import type { Assets } from "./Assets.ts";
import type { BrowserBinding } from "./BrowserBinding.ts";
import type { DurableObjectLike } from "./DurableObject.ts";
import type { RateLimitBinding } from "./RateLimitBinding.ts";
import type { RpcErrorEnvelope, RpcStreamEnvelope } from "./Rpc.ts";
import type { VersionMetadataBinding } from "./VersionMetadataBinding.ts";
import type { Worker } from "./Worker.ts";
import type { WorkerLoader as WorkerLoaderResource } from "./WorkerLoader.ts";

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
    : T extends FlagshipNs.App
      ? Flagship
      : T extends Assets
        ? Service
        : T extends Rpc<infer Shape extends object>
          ? RpcWireShape<Shape> & Service
          : T extends D1.Database
            ? D1Database
            : T extends R2.Bucket
              ? R2Bucket
              : T extends KV.Namespace
                ? KVNamespace
                : T extends DispatchNamespaceResource
                  ? DispatchNamespace
                  : T extends Queues.Queue
                    ? Queue<unknown>
                    : T extends AI.Gateway
                      ? Ai
                      : T extends AIBinding
                        ? Ai
                        : T extends AI.Search
                          ? AiSearchInstance
                          : T extends AI.SearchNamespace
                            ? AiSearchNamespace
                            : T extends Email.SendEmail
                              ? SendEmail
                              : T extends AnalyticsEngine.Dataset
                                ? AnalyticsEngineDataset
                                : T extends ArtifactsNs.Namespace
                                  ? Artifacts
                                  : T extends RateLimitBinding
                                    ? RateLimit
                                    : T extends ImagesNs.ImagesBinding
                                      ? ImagesBinding
                                      : T extends BrowserBinding
                                        ? BrowserRun
                                        : T extends HyperdriveNs.Connection
                                          ? Hyperdrive
                                          : T extends VersionMetadataBinding
                                            ? WorkerVersionMetadata
                                            : T extends WorkerLoaderResource
                                              ? WorkerLoader
                                              : T extends WorkflowLike<
                                                    infer Params
                                                  >
                                                ? Workflow<Params>
                                                : T extends DurableObjectLike
                                                  ? DurableObjectNamespace<
                                                      Exclude<
                                                        T["Shape"],
                                                        undefined
                                                      >
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
 * Use {@link toRpcAsync} to wrap a binding into a Promise<T>-flavored view
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
