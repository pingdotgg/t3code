import type {
  BindingHook,
  BindingServices,
} from "@alchemy.run/cloudflare-runtime/core";
import {
  Ai,
  AiSearch,
  AnalyticsEngine,
  Artifacts,
  Assets,
  Browser,
  D1,
  Data,
  DispatchNamespace,
  DurableObjectNamespace,
  Flagship,
  Hyperdrive,
  Images,
  Json,
  KvNamespace,
  MtlsCertificate,
  Pipelines,
  Queue,
  R2Bucket,
  RateLimit,
  SecretKey,
  SecretsStore,
  SendEmail,
  Service,
  Stream as StreamSim,
  Text,
  Vectorize,
  VersionMetadata,
  VpcService,
  WasmModule,
  WorkerLoader,
  Workflows,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { isLocalId } from "../LocalRuntime.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";

export class WorkerValidationError extends Schema.TaggedError<WorkerValidationError>()(
  "WorkerValidationError",
  {
    message: Schema.String,
    hint: Schema.optional(Schema.String),
    value: Schema.Unknown,
  },
) {}

export const toRuntimeBinding = Effect.fn(function* (
  b: WorkerBinding,
  /**
   * Dev-only channel from the Worker's binding data (see the `devRemote`
   * member of the Worker binding contract): binding name → opt-out of local
   * emulation for the capabilities that support it (browser / images /
   * stream / send_email).
   */
  devRemote?: Record<string, boolean>,
) {
  const unsupported = () =>
    new WorkerValidationError({
      message: `${b.type} bindings are not supported in local mode`,
      value: b,
    });
  switch (b.type) {
    case "ai":
      return Ai.remote(b.name);
    case "ai_search":
      return AiSearch.remote(b.name, b.instanceName);
    case "ai_search_namespace":
      return AiSearch.remoteNamespace(b.name, b.namespace);
    case "analytics_engine":
      return AnalyticsEngine.local(b.name, b.dataset);
    case "artifacts":
      return Artifacts.remote(b.name, b.namespace);
    case "assets":
      return Assets.local(b.name);
    case "browser":
      // Local emulation launches a real headless Chrome on this machine and
      // proxies the Browser Rendering session protocol to its CDP endpoint;
      // `Alchemy.remote()` opts into the real service instead.
      return devRemote?.[b.name]
        ? Browser.remote(b.name)
        : Browser.local({ binding: b.name });
    case "d1":
      // A `dev:` id belongs to a locally-emulated database (local D1
      // provider); a real id is a live database the dev worker proxies to
      // (e.g. the resource opted out of emulation via `Alchemy.remote()`).
      return isLocalId(b.databaseId)
        ? D1.local({ binding: b.name, id: b.databaseId })
        : D1.remote(b.name, b.databaseId);
    case "data_blob":
      return Data.local(b.name, Buffer.from(b.part));
    case "dispatch_namespace":
      return DispatchNamespace.remote({
        binding: b.name,
        namespace: b.namespace,
      });
    case "durable_object_namespace":
      return DurableObjectNamespace.local({
        binding: b.name,
        className: b.className,
        scriptName: b.scriptName,
        uniqueKey:
          b.namespaceId ??
          encodeURIComponent(`${b.scriptName!}-${b.className}`),
      });
    case "flagship":
      return Flagship.remote(b.name, b.appId);
    case "hyperdrive":
      return Hyperdrive.local(b.name, b.id);
    case "images":
      // Local emulation runs transforms via Sharp on this machine and stores
      // hosted images in a local KV-backed store; `Alchemy.remote()`
      // opts into the real Images service instead.
      return devRemote?.[b.name]
        ? Images.remote(b.name)
        : Images.local({ binding: b.name });
    case "inherit":
      return yield* unsupported();
    case "json":
      return Json.local(b.name, b.json);
    case "kv_namespace":
      // A `dev:` id belongs to a locally-emulated namespace; a real id is
      // a live namespace the dev worker proxies to.
      return isLocalId(b.namespaceId)
        ? KvNamespace.local({ binding: b.name, id: b.namespaceId })
        : KvNamespace.remote(b.name, b.namespaceId);
    case "mtls_certificate":
      return MtlsCertificate.remote(b.name, b.certificateId);
    case "pipelines":
      return Pipelines.remote(b.name, b.pipeline);
    case "plain_text":
      return Text.local(b.name, b.text);
    case "queue": {
      // A real queueId belongs to an `Alchemy.remote()` queue. Queue bindings
      // are NOT supported in Cloudflare's remote/preview sessions — a
      // platform limitation (cloudflare/workers-sdk#9929) — so live
      // production goes through the deployed shim worker registered at
      // eval time (see `Queues/QueueShim.ts`): the local binding targets a
      // forwarder service that relays the queue wire protocol to the shim
      // over HTTPS with a bearer token.
      if (b.queueId !== undefined && !isLocalId(b.queueId)) {
        const url = b.shim?.url;
        const token = b.shim?.token;
        if (url === undefined || token === undefined) {
          // Defensive: binding data produced by current eval always carries
          // the shim for this mode combination.
          return yield* new WorkerValidationError({
            message:
              `Queue binding "${b.name}" targets a live queue ` +
              "(Alchemy.remote()) but no producer shim was registered for it — " +
              "re-deploy, or remove remote() from the queue (local emulation).",
            value: b,
          });
        }
        return Queue.remote({
          binding: b.name,
          queueName: b.queueName,
          url,
          token: typeof token === "string" ? token : Redacted.value(token),
        });
      }
      return Queue.local({
        binding: b.name,
        queueName: b.queueName,
      });
    }
    case "r2_bucket":
      // A `dev:`-prefixed bucket name belongs to a locally-emulated bucket
      // (R2 has no opaque id — the name is the identity); a real name is a
      // live bucket the dev worker proxies to.
      return isLocalId(b.bucketName)
        ? R2Bucket.local({ binding: b.name, id: b.bucketName })
        : R2Bucket.remote(b.name, b.bucketName, b.jurisdiction);
    case "ratelimit":
      return RateLimit.local({
        binding: b.name,
        simple: b.simple,
        namespaceId: b.namespaceId,
      });
    case "secret_key":
      // workerd imports the key natively: raw material passes through as
      // base64, pkcs8/spki base64 DER is PEM-wrapped, and JWK objects are
      // serialized — all handled by the hook.
      return SecretKey.local({
        binding: b.name,
        format: b.format,
        algorithm: b.algorithm,
        usages: b.usages,
        keyBase64: b.keyBase64,
        keyJwk: b.keyJwk,
      });
    case "secret_text":
      return Text.local(b.name, b.text);
    case "secrets_store_secret":
      // A `dev:` store id belongs to a locally-emulated Secrets Store
      // (local Store/Secret providers seed the simulator); a real id is a
      // live secret the dev worker proxies to (`Alchemy.remote()`).
      return isLocalId(b.storeId)
        ? SecretsStore.local({
            binding: b.name,
            storeId: b.storeId,
            secretName: b.secretName,
          })
        : SecretsStore.remote(b.name, b.storeId, b.secretName);
    case "send_email":
      // Local emulation validates and persists sent mail as `.eml` files
      // under the local storage's `email/` dir; `Alchemy.remote()` on the
      // descriptor opts into the real Email service instead.
      return SendEmail[devRemote?.[b.name] ? "remote" : "local"]({
        binding: b.name,
        destinationAddress: b.destinationAddress,
        allowedDestinationAddresses: b.allowedDestinationAddresses,
        allowedSenderAddresses: b.allowedSenderAddresses,
      });
    case "self_service":
      // A service binding to the worker itself: served in-process by the
      // runtime's self service (bypasses the assets middleware), matching
      // the production `service: <own name>` lowering.
      return Service.self(b.name);
    case "service":
      return Service.local({
        binding: b.name,
        scriptName: b.service,
        entrypoint: b.entrypoint,
        props: b.props,
      });
    case "stream":
      // Local emulation stores videos in a local simulator (no transcoding,
      // no signed URLs) and serves each video's `preview` URL at
      // /cdn-cgi/mf/stream/<id>/watch on the dev URL; `Alchemy.remote()`
      // opts into the real Stream service instead.
      return devRemote?.[b.name]
        ? StreamSim.remote(b.name)
        : StreamSim.local({ binding: b.name });
    case "text_blob":
      return Data.local(b.name, Buffer.from(b.part));
    case "vectorize":
      return Vectorize.remote(b.name, b.indexName);
    case "version_metadata":
      return VersionMetadata.local(b.name);
    case "vpc_service":
      // A VPC service tunnels into a private network — nothing to emulate
      // locally, so the dev worker always proxies to the real service
      // through the remote-binding bridge.
      return VpcService.remote(b.name, b.serviceId);
    case "wasm_module":
      return WasmModule.local(b.name, Buffer.from(b.part));
    case "worker_loader":
      return WorkerLoader.local(b.name);
    case "workflow":
      return Workflows.local({
        binding: b.name,
        workflowName: b.workflowName,
        className: b.className,
        scriptName: b.scriptName,
      });
    default:
      return yield* unsupported();
  }
});

/**
 * Turns the serializable half of a local Worker configuration into the
 * cloudflare-runtime binding hooks consumed by `Runtime.start`.
 *
 * Kept in a leaf module, independent of the provider, so a Vite child
 * process can reconstruct the hooks after receiving plain binding
 * descriptors from its parent without evaluating the provider's module
 * graph. Binding hooks themselves are Effects and cannot cross a process
 * boundary.
 *
 * `config.env` must already be resolved to plain values — `Worker.URL`
 * sentinels substituted with the actual dev-proxy URL by the caller.
 */
export const materializeRuntimeBindings = Effect.fn(function* (
  config: {
    name: string;
    env?: Record<string, unknown>;
    hasAssets: boolean;
    bindingDescriptors: WorkerBinding[];
    /** Binding name → opt-out of local emulation (`Alchemy.remote()`). */
    devRemote?: Record<string, boolean>;
    /**
     * Simulated Cloudflare Access config (`dev: { access: ... }`), lowered
     * into the `ALCHEMY_DEV_ACCESS` env binding the worker bridge reads to
     * serve `ctx.access` locally.
     */
    devAccess?: { aud?: string; identity?: Record<string, unknown> };
  },
  options: {
    accountId: string;
    selfUrl: string | undefined;
    stack: { name: string; stage: string };
  },
) {
  // Resource-backed env entries (e.g. `env: { KV: namespace }`) are
  // represented by their binding descriptor (same name) — don't ALSO
  // serialize the resolved attributes as a duplicate json binding.
  const descriptorNames = new Set(
    config.bindingDescriptors.map((descriptor) => descriptor.name),
  );
  const workerBindings: BindingHook<BindingServices>[] = [
    Text.local("ALCHEMY_PHASE", "runtime"),
    Text.local("ALCHEMY_WORKER_NAME", config.name),
    Text.local("ALCHEMY_STACK_NAME", options.stack.name),
    Text.local("ALCHEMY_STAGE", options.stack.stage),
    Text.local("ALCHEMY_CLOUDFLARE_ACCOUNT_ID", options.accountId),
    ...Object.entries(config.env ?? {})
      .filter(([key]) => !descriptorNames.has(key))
      .map(([key, value]) => {
        const unredacted = Redacted.isRedacted(value)
          ? Redacted.value(value)
          : value;
        return typeof unredacted === "string"
          ? Text.local(key, unredacted)
          : Json.local(key, unredacted);
      }),
    ...(config.hasAssets ? [Assets.local("ASSETS")] : []),
    ...(config.devAccess !== undefined
      ? [Json.local("ALCHEMY_DEV_ACCESS", config.devAccess)]
      : []),
  ];
  for (const descriptor of config.bindingDescriptors) {
    if (descriptor.type === "self_url") {
      // Lowered here rather than in `toRuntimeBinding` — only the caller
      // knows the worker's own dev-proxy URL.
      workerBindings.push(Text.local(descriptor.name, options.selfUrl!));
      continue;
    }
    workerBindings.push(yield* toRuntimeBinding(descriptor, config.devRemote));
  }
  return workerBindings;
});
