import type * as workers from "@distilled.cloud/cloudflare/workers";
import type * as Output from "alchemy/Output";
import type { Rpc } from "alchemy/Rpc";
import { isYieldableEffectLike } from "alchemy/Util/effect";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Json } from "effect/Schema";
import type { Gateway as AiGateway } from "../AI/Gateway.ts";
import type { SearchInstance } from "../AI/SearchInstance.ts";
import type { SearchNamespace } from "../AI/SearchNamespace.ts";
import { Dataset } from "../AnalyticsEngine/Dataset.ts";
import type { Namespace as ArtifactsNamespace } from "../Artifacts/Namespace.ts";
import type { Container } from "../Containers/Container.ts";
import type { Database as D1Database } from "../D1/Database.ts";
import { SendEmail } from "../Email/SendEmail.ts";
import type { App as FlagshipApp } from "../Flagship/App.ts";
import type { Connection as Hyperdrive } from "../Hyperdrive/Connection.ts";
import type { ConnectionLookup as HyperdriveLookup } from "../Hyperdrive/ConnectionLookup.ts";
import type { ImagesBinding } from "../Images/ImagesBinding.ts";
import type { Stream as K2Stream } from "../K2/Stream.ts";
import type { InstantNamespace } from "../KV/InstantNamespace.ts";
import type { Namespace } from "../KV/Namespace.ts";
import type { MtlsCertificate } from "../MtlsCertificate/MtlsCertificate.ts";
import type { LegacyPipeline } from "../Pipelines/LegacyPipeline.ts";
import type { Stream as PipelinesStream } from "../Pipelines/Stream.ts";
import type { Queue } from "../Queues/Queue.ts";
import type { Bucket } from "../R2/Bucket.ts";
import type { S3Credentials } from "../R2/S3Credentials.ts";
import type { Secret } from "../SecretsStore/Secret.ts";
import type { StreamBinding } from "../Stream/StreamBinding.ts";
import type { Index as VectorizeIndex } from "../Vectorize/VectorizeIndex.ts";
import type { VpcService } from "../VpcService/VpcService.ts";
import type { VpcServiceLookup } from "../VpcService/VpcServiceLookup.ts";
import type { DispatchNamespace } from "../WorkersForPlatforms/DispatchNamespace.ts";
import type { WorkflowLike } from "../Workflows/Workflow.ts";
import type { AIBinding } from "./AIBinding.ts";
import type { Assets } from "./Assets.ts";
import type { AnyBindingEffect } from "./Binding.ts";
import type { BrowserBinding } from "./BrowserBinding.ts";
import cloudflare_workers from "./cloudflare_workers.ts";
import type { DurableObjectLike } from "./DurableObject.ts";
import type { RateLimitBinding } from "./RateLimitBinding.ts";
import { makeRpcStub } from "./Rpc.ts";
import type { SecretKeyBinding } from "./SecretKeyBinding.ts";
import type { VersionMetadataBinding } from "./VersionMetadataBinding.ts";
import type { URLEffect } from "./Worker.ts";
import { Worker, WorkerEnvironment } from "./Worker.ts";
import type { WorkerEntrypointBinding } from "./WorkerEntrypoint.ts";
import type { WorkerLoader } from "./WorkerLoader.ts";

type DistilledWorkerBinding = Exclude<
  workers.PutScriptRequest["metadata"]["bindings"],
  undefined
>[number];

/**
 * The `durable_object_namespace` metadata binding extended with alchemy-only
 * transfer metadata. `transferredFrom` names the Worker(s) — by logical id in
 * this stack + stage, or by physical script name — that previously hosted the
 * class, so the provider can drive Cloudflare's data-preserving
 * `transferred_classes` migration. It is stripped from the binding before the
 * script upload — Cloudflare never sees it.
 */
export type DurableObjectNamespaceWorkerBinding = Extract<
  DistilledWorkerBinding,
  { type: "durable_object_namespace" }
> & {
  transferredFrom?: string | string[];
  /** The class's declared storage backend; alchemy-only, never uploaded. */
  storage?: "sqlite" | "legacy-kv";
};

/**
 * Alchemy-only binding: the host Worker's own public URL (`Worker.URL`). The
 * provider resolves the URL the Worker will be served at (first custom domain,
 * else its `workers.dev` URL) and lowers this into a `plain_text` binding
 * before the script upload — Cloudflare never sees this type.
 */
export interface SelfUrlWorkerBinding {
  type: "self_url";
  name: string;
}

/**
 * Alchemy-only binding: a service binding that points at the host Worker
 * ITSELF (`Worker.Self`). The provider lowers this into a
 * `service` binding targeting the Worker's own physical name just before
 * the script upload — Cloudflare never sees this type. In local dev it
 * lowers to the runtime's in-process self service (bypassing the assets
 * middleware), matching production semantics.
 *
 * The canonical consumer is OpenNext's `WORKER_SELF_REFERENCE` (the ISR
 * revalidation queue re-fetches the worker through it).
 */
export interface SelfServiceWorkerBinding {
  type: "self_service";
  name: string;
  /** Named `WorkerEntrypoint` class to target; omitted → default export. */
  entrypoint?: string;
  /** `ctx.props` delivered to the entrypoint. */
  props?: Record<string, unknown>;
}

/**
 * Alchemy-only, dev-only binding: R2 S3 credentials for a locally-emulated
 * (`dev:`) bucket (`Cloudflare.R2.S3Credentials`). The local runtime lowers
 * it into a text binding holding the credentials JSON for the Worker's local
 * S3 endpoint (`{worker url}/cdn-cgi/local/r2/s3`) and serves the bucket on
 * that endpoint. Deployed Workers receive a `secret_text` binding instead —
 * Cloudflare never sees this type.
 */
export interface R2S3CredentialsWorkerBinding {
  type: "r2_s3_credentials";
  name: string;
  bucketName: string;
}

/**
 * The `queue` metadata binding extended with the alchemy-only `queueId`.
 * The local worker provider uses it to discriminate a locally-emulated
 * queue (`dev:` id → local broker) from an `Alchemy.remote()` queue in dev
 * (real id → remote-proxied producer). Stripped from the binding before
 * the script upload — Cloudflare never sees it.
 */
export type QueueWorkerBinding = Extract<DistilledWorkerBinding, { type: "queue" }> & {
  queueId?: string;
  /**
   * Alchemy-only (stripped before upload): dev-mode remote-producer shim
   * for an `Alchemy.remote()` queue. Cloudflare preview sessions reject
   * queue bindings, so a local worker produces to the live queue through
   * this deployed shim worker instead (see `Queues/QueueShim.ts`).
   */
  shim?: {
    /** The shim worker's workers.dev URL. */
    url: string | undefined;
    /** Bearer token the shim requires. */
    token: Redacted.Redacted<string> | string;
  };
};

/**
 * The `k2` metadata binding: produce-only access to a K2 stream, by stream
 * id (`Cloudflare.K2.WriteStreamBinding`, or a `K2.Stream` in `env`).
 */
export type K2WorkerBinding = Extract<DistilledWorkerBinding, { type: "k2" }>;

/**
 * The `service` metadata binding extended with workerd's `ctx.props`.
 * `props` is what a `Cloudflare.WorkerEntrypoint(worker, { props })` env
 * entry lowers to; the local runtime delivers it to the target entrypoint.
 * The Cloudflare API's binding schema does not carry the field yet, so on
 * live uploads it is dropped at encode until the distilled `workers`
 * service adds it.
 */
export type ServiceWorkerBinding = Extract<DistilledWorkerBinding, { type: "service" }> & {
  props?: Record<string, unknown>;
};

/**
 * The wire-shape binding union the Cloudflare API accepts — {@link WorkerBinding}
 * minus the alchemy-only members that must be lowered before upload.
 */
export type WireWorkerBinding = Exclude<
  WorkerBinding,
  SelfUrlWorkerBinding | SelfServiceWorkerBinding | R2S3CredentialsWorkerBinding
>;

export type WorkerBinding =
  | Exclude<
      DistilledWorkerBinding,
      { type: "durable_object_namespace" } | { type: "queue" } | { type: "service" }
    >
  | DurableObjectNamespaceWorkerBinding
  | QueueWorkerBinding
  | ServiceWorkerBinding
  | SelfUrlWorkerBinding
  | SelfServiceWorkerBinding
  | R2S3CredentialsWorkerBinding;

/**
 * Drop dev-only binding sentinels ({@link R2S3CredentialsWorkerBinding})
 * before a live upload. They are only emitted for Workers running locally,
 * so a live Worker never carries one; this narrows the type for the wire.
 */
export const withoutDevOnlyBindings = <B extends WorkerBinding>(
  bindings: ReadonlyArray<B>,
): Array<Exclude<B, R2S3CredentialsWorkerBinding>> =>
  bindings.filter(
    (binding): binding is Exclude<B, R2S3CredentialsWorkerBinding> =>
      binding.type !== "r2_s3_credentials",
  );

export type WorkerSettingsBinding = Exclude<
  workers.GetScriptScriptAndVersionSettingResponse["bindings"],
  null | undefined
>[number];

export type WorkerBindingResource =
  // Config values
  | Json
  | Redacted.Redacted<Json>
  | Config.Config<Json>
  // Outputs that resolve to a plain env value (e.g. `Alchemy.makeRandom`,
  // `Output.literal`), classified by their resolved value at deploy time.
  // Whole-resource Outputs (`Output.of(bucket)`) cannot be excluded here:
  // `Input<T>` wraps this whole union in `Output<T>`, so any Output whose
  // A is structurally Json (most resource attribute shapes) is admitted
  // upstream regardless of this arm. `bindWorkerAsyncBindings` rejects
  // them at deploy time instead.
  | Output.Output<Json | Redacted.Redacted<Json>, unknown>
  // CF resources
  | Assets
  | Bucket
  | S3Credentials
  | D1Database
  | Namespace
  | InstantNamespace
  | Queue
  | AiGateway
  | AIBinding
  | SearchInstance
  | SearchNamespace
  | Dataset
  | SendEmail
  | ArtifactsNamespace
  | RateLimitBinding
  | SecretKeyBinding
  | BrowserBinding
  | FlagshipApp
  | ImagesBinding
  | StreamBinding
  | PipelinesStream
  | LegacyPipeline
  | K2Stream
  | Hyperdrive
  | HyperdriveLookup
  | VectorizeIndex
  | Secret
  | Worker
  | WorkerEntrypointBinding<any>
  | WorkerLoader
  | VersionMetadataBinding
  // The Worker's own URL (`Worker.URL`).
  | URLEffect
  // A Worker-only binding lifted by `.pipe(Alchemy.remote())`.
  | AnyBindingEffect
  | DispatchNamespace
  | DurableObjectLike<any>
  | WorkflowLike<any>
  | VpcService
  | VpcServiceLookup
  // An account-level mTLS certificate becomes an `mtls_certificate` binding.
  | MtlsCertificate
  // A Container bound directly in `env` declares a container-backed Durable
  // Object class (DO namespace binding + ContainerApplication in one).
  | Container.Decl.Any;

export type WorkerBindings = {
  [bindingName in string]: WorkerBindingResource;
};

/**
 * Whether `target` names the Worker being constructed. A Worker class only
 * carries its static `LogicalId` (one logical id is one resource within a
 * stack); a resolved resource carries its full `FQN`, so a `Worker.ref` to
 * the same logical id in another stack or stage is not the host.
 */
const isHostWorker = (target: unknown, host: Worker): boolean => {
  if (typeof target !== "function" && (typeof target !== "object" || target === null)) {
    return false;
  }
  if ("FQN" in target) return target.FQN === host.FQN;
  return "LogicalId" in target && target.LogicalId === host.LogicalId;
};

export const bindWorker = Effect.fn(function* <Shape, Req = never>(
  workerEff: (Worker & Rpc<Shape>) | Effect.Effect<Worker & Rpc<Shape>, never, Req>,
) {
  const self = yield* Worker;
  if (isHostWorker(workerEff, self)) {
    // A Worker binding itself. Yielding its own class here would wait on
    // its own construction, and a service binding naming its own script is
    // unnecessary: workerd's `ctx.exports.default` is a loopback to this
    // Worker's default entrypoint, so nothing is deployed for the binding.
    return makeRpcStub<Shape>(
      cloudflare_workers.pipe(
        Effect.map(({ exports }) => (exports as Record<string, unknown>).default),
      ),
    );
  }
  // Worker classes and regular Effects are both yieldable here.
  const worker = isYieldableEffectLike(workerEff)
    ? yield* workerEff as Effect.Effect<Worker & Rpc<Shape>, never, Req>
    : workerEff;
  yield* self.bind`${worker}`({
    bindings: [
      {
        type: "service",
        name: worker.LogicalId,
        service: worker.workerName,
      },
    ],
  });

  // `bindWorker` runs at *init* phase (both at plantime and at runtime
  // cold-start). `WorkerEnvironment` only exists at exec phase on the
  // deployed worker, so we hand `makeRpcStub` an `Effect<stub>` that
  // resolves the binding lazily on each method call.
  const stubEff = WorkerEnvironment.pipe(
    Effect.map((env) => (env as Record<string, unknown>)[worker.LogicalId]),
  );
  return makeRpcStub<Shape>(stubEff);
});
