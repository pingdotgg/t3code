import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Json } from "effect/Schema";
import type { InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { ResourceBinding } from "../../Resource.ts";
import * as Namespace from "../../Namespace.ts";
import { defaultProviderMode } from "../../ProviderMode.ts";
import { isYieldableEffectLike } from "../../Util/effect.ts";
import {
  Application,
  isApplication,
  type Application as AccessApplication,
} from "../Access/Application.ts";
import { isAiGateway } from "../AI/Gateway.ts";
import { isSearchInstance } from "../AI/SearchInstance.ts";
import { isSearchNamespace } from "../AI/SearchNamespace.ts";
import { isDataset } from "../AnalyticsEngine/Dataset.ts";
import { isNamespace } from "../Artifacts/Namespace.ts";
import type { Container } from "../Containers/Container.ts";
import type { ContainerApplication } from "../Containers/ContainerApplication.ts";
import { isDatabase } from "../D1/Database.ts";
import { isSendEmail } from "../Email/SendEmail.ts";
import { isApp } from "../Flagship/App.ts";
import { getHyperdriveDevOrigin } from "../Hyperdrive/ConnectBinding.ts";
import { isHyperdriveConnection } from "../Hyperdrive/Connection.ts";
import { isImages } from "../Images/Images.ts";
import { isNamespace as isKVNamespace } from "../KV/Namespace.ts";
import { isLegacyPipeline } from "../Pipelines/LegacyPipeline.ts";
import { isStream as isPipelinesStream } from "../Pipelines/Stream.ts";
import { isQueue } from "../Queues/Queue.ts";
import { maybeQueueShim } from "../Queues/QueueShim.ts";
import { isBucket } from "../R2/Bucket.ts";
import { isSecret } from "../SecretsStore/Secret.ts";
import { isStream } from "../Stream/Stream.ts";
import { isIndex } from "../Vectorize/VectorizeIndex.ts";
import { isVpcService } from "../VpcService/VpcService.ts";
import type { VpcServiceLookup } from "../VpcService/VpcServiceLookup.ts";
import { isDispatchNamespace } from "../WorkersForPlatforms/DispatchNamespace.ts";
import { isWorkflowLike, WorkflowResource } from "../Workflows/Workflow.ts";
import { makeWorkflowName } from "../Workflows/WorkflowName.ts";
import { isAI } from "./AI.ts";
import { isAssets } from "./Assets.ts";
import { isBinding as isWorkerOnlyBinding } from "./Binding.ts";
import { isBrowser } from "./Browser.ts";
import {
  isDurableObjectLike,
  normalizeTransferredFrom,
} from "./DurableObject.ts";
import { isRateLimit } from "./RateLimit.ts";
import { isSecretKey } from "./SecretKey.ts";
import { isVersionMetadata } from "./VersionMetadata.ts";
import type { WorkerBindingProps } from "./Worker.ts";
import {
  isSelf,
  isSelfUrl,
  isWorker,
  type Worker,
  type WorkerObservability,
  type WorkerProps,
} from "./Worker.ts";
import type { WorkerAccessApplication } from "./WorkerAccess.ts";
import type { WorkerBinding, WorkerBindingResource } from "./WorkerBinding.ts";
import { isWorkerEntrypoint } from "./WorkerEntrypoint.ts";
import { isWorkerLoader } from "./WorkerLoader.ts";

export const bindWorkerAsyncBindings = Effect.fn(function* (
  resource: Worker,
  props: InputProps<WorkerProps<WorkerBindingProps>>,
) {
  // Access enrollment (`access` prop): push this Worker's
  // `worker`/`preview_worker` destinations onto the application's binding
  // contract. The application deploys with — and converges on — every
  // enrolled Worker's destinations, including at create time, where
  // Cloudflare requires a self-hosted app to be born with a domain or
  // destinations.
  //
  // Skipped when this Worker runs locally (`alchemy dev`): a local worker
  // has no cloud script (no immutable ID to enroll), and Access cannot
  // front a localhost URL — the `dev.access` stub covers the runtime
  // instead. A Worker opted out via `Alchemy.remote()` enrolls normally.
  const accessHostMode = resource.Mode ?? (yield* defaultProviderMode);
  if (props.access && accessHostMode !== "local") {
    const accessInput = props.access;
    // The shared form is the application itself — as the module-scope
    // declaration Effect (`const App = Cloudflare.Access.Application(...)`)
    // or an already-yielded resource. Resolve the yieldable spelling first,
    // then discriminate.
    const access = (
      isYieldableEffectLike(accessInput) && !Output.isOutput(accessInput)
        ? yield* accessInput as Effect.Effect<unknown>
        : accessInput
    ) as AccessApplication | InputProps<WorkerAccessApplication>;
    const application = isApplication(access)
      ? access
      : // Dedicated form: declare an application owned by this Worker —
        // per-Worker Access configuration means a per-Worker application
        // (Cloudflare attaches policies to applications, not Workers). It
        // lives in the Worker's namespace: `<Worker>/Access`.
        yield* Application("Access", {
          type: "self_hosted",
          name: access.name,
          policies: access.policies,
          sessionDuration: access.sessionDuration,
          allowedIdps: access.allowedIdps,
          autoRedirectToIdentity: access.autoRedirectToIdentity,
          appLauncherVisible: access.appLauncherVisible,
        }).pipe(Namespace.push(resource.LogicalId));
    const previews = isApplication(access) || access.previews !== false;
    yield* application.bind(`enroll:${resource.FQN}`, {
      destinations: [
        { type: "worker", workerId: resource.workerId },
        ...(previews
          ? [
              {
                type: "preview_worker" as const,
                workerId: resource.workerId,
              },
            ]
          : []),
      ],
    });
  }
  if (props.env) {
    for (const bindingName in props.env) {
      // @ts-expect-error
      const bindingEff = props.env?.[bindingName] as
        | WorkerBindingResource
        | Effect.Effect<WorkerBindingResource>;
      // A Container bound directly in `env` declares a container-backed
      // Durable Object class: the Container IS the DO namespace binding plus
      // its ContainerApplication. Handled before the generic Effect
      // resolution below — yielding the Container class would resolve its
      // *started instance* tag, which only exists inside a Durable Object.
      if (isContainerDecl(bindingEff)) {
        yield* bindContainerClass(resource, bindingName, bindingEff);
        continue;
      }
      // Bindings can be passed as a plain resource value, an Effect that
      // yields a resource, or an effect-class (e.g. a `Cloudflare.Worker`
      // class). Resolve the yieldable forms before deriving binding metadata.
      // Avoid yielding outputs as this requires `RuntimeContext`;
      // allow the engine to resolve them instead.
      const binding = (
        isYieldableEffectLike(bindingEff) && !Output.isOutput(bindingEff)
          ? yield* bindingEff as Effect.Effect<unknown>
          : bindingEff
      ) as WorkerBindingResource;

      // Queue producer bindings may need the dev-mode remote-producer shim
      // (a LOCAL worker binding a LIVE queue): `maybeQueueShim` registers
      // the shim worker + token resources at eval time — the same idiom as
      // the WorkflowResource registration below — and contributes their
      // outputs to the binding data.
      if (isQueue(binding)) {
        const shim = yield* maybeQueueShim(binding, resource);
        yield* resource.bind`${bindingName}`({
          bindings: [
            {
              type: "queue",
              name: bindingName,
              queueName: binding.queueName,
              // Alchemy-only mode discriminator for dev (stripped before
              // upload).
              queueId: binding.queueId,
              ...(shim ? { shim } : {}),
            },
          ],
        });
        continue;
      }

      const bindingMeta:
        | BindingSpec
        | Output.Output<WorkerBinding>
        | undefined = toBinding(bindingName, binding);

      if (Output.isOutput(bindingMeta)) {
        // A whole-resource Output resolves to the resource's raw attributes;
        // uploading those as a plaintext json env var is never intended.
        // This cannot be rejected at compile time (`Input<T>` admits any
        // Output whose A is structurally Json), so this guard is the
        // enforcement point.
        if (Output.isResourceExpr(binding) || Output.isRefExpr(binding)) {
          return yield* Effect.die(
            `Cannot bind whole-resource Output "${bindingName}": pass the resource (or a typed ref) directly, or bind one of its attribute Outputs`,
          );
        }
        // Deferred classification (see `toBinding`'s Output arm): the engine
        // resolves the Output inside the binding data before the Worker
        // provider reads it.
        yield* resource.bind`${bindingName}`({ bindings: [bindingMeta] });
        continue;
      }

      if (bindingMeta) {
        let resolvedBindingMeta: InputProps<WorkerBinding> = bindingMeta;

        if (isWorkflowLike(binding)) {
          const className = binding.className ?? binding.name;
          const scriptName = binding.scriptName ?? resource.workerName;
          const workflowName = makeWorkflowName(scriptName, className);
          resolvedBindingMeta = {
            ...resolvedBindingMeta,
            workflowName,
          };

          // A locally-hosted Workflow (no `scriptName`) must be registered
          // with Cloudflare via `putWorkflow` once the host Worker exists.
          // Cross-script references are binding-only; both sides derive the
          // same physical workflow name from the host script and class.
          if (!binding.scriptName) {
            yield* WorkflowResource(binding.name, {
              workflowName,
              className,
              scriptName: resource.workerName,
              limits: binding.limits,
              schedules: binding.schedules,
            });
          }
        }

        yield* resource.bind`${bindingName}`({
          bindings: [resolvedBindingMeta],
          hyperdrives: isHyperdriveConnection(binding)
            ? getHyperdriveDevOrigin(binding)
            : undefined,
          // Dev-only local-emulation opt-out channel (like `hyperdrives`):
          // worker-only bindings and `SendEmail` descriptors piped through
          // `Alchemy.remote()` carry the internal `devRemote` flag on their
          // binding value; contribute it as binding data so the wire binding
          // stays pure.
          devRemote:
            (isWorkerOnlyBinding(binding) || isSendEmail(binding)) &&
            binding.devRemote
              ? { [bindingName]: true }
              : undefined,
        });
      } else {
        // Defensive catch-all: `toBinding` currently always classifies
        // (its final arm is the `json` fallback), but keep the branch so a
        // future gap fails loudly instead of silently skipping the binding.
        return yield* Effect.die(`Unknown binding type: ${bindingName}`);
      }
    }
  }
});

/**
 * Structural check for a `Cloudflare.Container` class declaration. Keyed on
 * the `~alchemy/Container/ClassName` marker (rather than importing from
 * `Containers/Container.ts`) to avoid a value-level import cycle through
 * `ContainerPlatform` → `Worker.ts` → this module.
 *
 * A Container declaration is Effect-shaped (yielding it resolves the
 * *started instance* tag, which only exists inside a Durable Object), so
 * every env-resolution site must check this before `Effect.isEffect`.
 */
export const isContainerDecl = (value: unknown): value is Container.Decl.Any =>
  (typeof value === "function" || typeof value === "object") &&
  value !== null &&
  "~alchemy/Container/ClassName" in value;

/**
 * Structural check for a yielded {@link ContainerApplication} resource
 * instance (same import-cycle note as above).
 */
const isContainerApplicationResource = (
  value: unknown,
): value is ContainerApplication =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: unknown }).Type === "Cloudflare.Container";

/**
 * Wire a Container bound directly on an async Worker's `env`
 * (`env: { Sandbox: Cloudflare.Container("Sandbox", { image }) }`). Mirrors
 * v1 alchemy, where a Container binding is a Durable Object namespace plus
 * its ContainerApplication in one declaration:
 *
 * 1. emit the `durable_object_namespace` binding for the class,
 * 2. attach the class's namespace id to the ContainerApplication, and
 * 3. contribute `containers: [{ className }]` binding data so the Worker's
 *    script metadata marks the class as container-backed.
 *
 * The namespace id only exists once the Worker uploads, while the Worker's
 * metadata needs the container class — the same circularity as the
 * Effect-native path (`ContainerPlatform.bind`), resolved through bindings +
 * precreate.
 */
const bindContainerClass = Effect.fn(function* (
  resource: Worker,
  bindingName: string,
  decl: Container.Decl.Any,
) {
  // Effect-valued container props (the shape that threads a sibling
  // resource's outputs into `env`) can only surface `className` here, once
  // the props Effect runs.
  const declaredClassName = decl["~alchemy/Container/ClassName"];
  const className =
    (Effect.isEffect(declaredClassName)
      ? yield* declaredClassName
      : declaredClassName) ?? bindingName;
  // Resolve the ContainerApplication resource declaration carried on the
  // class. An effectful (`main`) container has no application declaration of
  // its own here (it is created by its `.make()` Layer inside a Durable
  // Object host), so it cannot back an async class.
  const declaration = (decl as { Application?: unknown }).Application;
  const application =
    isYieldableEffectLike(declaration) && !Output.isOutput(declaration)
      ? yield* declaration as Effect.Effect<unknown>
      : undefined;
  if (!isContainerApplicationResource(application)) {
    return yield* Effect.die(
      `Worker binding '${bindingName}' is a Container without a deployable image. Declare the container with props (image, or context/dockerfile) to bind it on an async Worker — effectful (main) containers require an Effect-native Durable Object host.`,
    );
  }
  // Both halves of the Worker's side describe the same env entry, so they
  // share one `sid`. Binding rows are collapsed by sid (last write wins), so
  // splitting them across two `bind` calls silently drops the namespace
  // binding whenever the two sids coincide — e.g. the env key and the
  // Container's logical id match (`Sandbox: Container("Sandbox", …)`). The
  // Worker then uploads the Container declaration itself as a `json` binding
  // and `env.NAME` is not a DO namespace at runtime.
  yield* resource.bind`${bindingName}`({
    bindings: [
      {
        type: "durable_object_namespace",
        name: bindingName,
        className,
      },
    ],
    containers: [
      {
        className,
        dev: application.dev,
        hash: application.hash.pipe(Output.map((h) => h?.image)),
      },
    ],
  });
  yield* application.bind`${bindingName}`({
    durableObjects: {
      namespaceId: resource.durableObjectNamespaces.pipe(
        Output.map((namespaces) => namespaces?.[className]),
      ),
    },
  });
});

type BindingSpec = InputProps<WorkerBinding>;

/**
 * Classify a plain env value (string / Redacted / Json) into its wire
 * binding. Called by {@link toBinding} both eagerly (literal values) and
 * deferred (the resolved value of an Output env entry).
 */
const toValueBinding = (
  bindingName: string,
  value: Json | Redacted.Redacted<Json>,
): WorkerBinding => {
  if (typeof value === "string") {
    return {
      type: "plain_text",
      name: bindingName,
      text: value,
    };
  }
  if (Redacted.isRedacted(value)) {
    const val = Redacted.value(value);
    return {
      type: "secret_text",
      name: bindingName,
      text: typeof val === "string" ? val : JSON.stringify(val),
    };
  }
  return {
    type: "json",
    name: bindingName,
    json: value,
  };
};

/**
 * Classify a binding into its wire shape.
 *
 * An Output that no native classifier recognized resolves to a plain env
 * value, unknown until the engine resolves it, so its classification
 * (plain_text vs secret_text vs json) is deferred to resolution time via
 * {@link toValueBinding} — classifying eagerly would fall through to the
 * `json` fallback and deploy e.g. a resolved `Redacted` secret as an
 * unencrypted json binding. Resource refs never land in the Output arm:
 * they surface their target's `Type` statically, so a native classifier
 * (kv_namespace, r2_bucket, ...) already matched above. Whole-resource
 * Outputs also land here (lazily, nothing is resolved); the caller rejects
 * them before the returned Output is ever bound.
 */
const toBinding = (
  bindingName: string,
  binding: WorkerBindingResource,
): BindingSpec | Output.Output<WorkerBinding, unknown> => {
  if (typeof binding === "string" || Redacted.isRedacted(binding)) {
    return toValueBinding(bindingName, binding);
  } else if (isAssets(binding)) {
    return {
      type: "assets",
      name: bindingName,
    };
  } else if (isNamespace(binding)) {
    return {
      type: "artifacts",
      name: bindingName,
      namespace: binding.namespace,
    };
  } else if (isImages(binding)) {
    return {
      type: "images",
      name: bindingName,
    };
  } else if (isBrowser(binding)) {
    return {
      type: "browser",
      name: bindingName,
    };
  } else if (isStream(binding)) {
    return {
      type: "stream",
      name: bindingName,
    };
  } else if (isApp(binding)) {
    return {
      type: "flagship",
      name: bindingName,
      appId: binding.appId,
    };
  } else if (isDataset(binding)) {
    return {
      type: "analytics_engine",
      name: bindingName,
      dataset: binding.dataset,
    };
  } else if (isRateLimit(binding)) {
    return {
      type: "ratelimit",
      name: bindingName,
      namespaceId: binding.namespaceId,
      simple: binding.simple,
    };
  } else if (isSecretKey(binding)) {
    return {
      type: "secret_key",
      name: bindingName,
      format: binding.format,
      algorithm: binding.algorithm,
      usages: binding.usages,
      keyBase64: binding.keyBase64,
      keyJwk: binding.keyJwk,
    };
  } else if (isSendEmail(binding)) {
    return {
      type: "send_email",
      name: bindingName,
      destinationAddress: binding.destinationAddress,
      allowedDestinationAddresses: binding.allowedDestinationAddresses,
      allowedSenderAddresses: binding.allowedSenderAddresses,
    };
  } else if (isDurableObjectLike(binding)) {
    return {
      type: "durable_object_namespace",
      name: bindingName,
      className: binding.className ?? binding.name,
      scriptName: binding.scriptName,
      transferredFrom: normalizeTransferredFrom(binding.transferredFrom),
    };
  } else if (isWorkflowLike(binding)) {
    return {
      type: "workflow",
      name: bindingName,
      workflowName: binding.workflowName ?? binding.name,
      className: binding.className ?? binding.name,
      scriptName: binding.scriptName,
    };
  } else if (isVpcService(binding)) {
    return {
      type: "vpc_service",
      name: bindingName,
      serviceId: binding.serviceId,
    };
  } else if (isDatabase(binding)) {
    return {
      type: "d1",
      databaseId: binding.databaseId,
      name: bindingName,
    };
  } else if (isBucket(binding)) {
    return {
      type: "r2_bucket",
      name: bindingName,
      bucketName: binding.bucketName,
      jurisdiction: binding.jurisdiction.pipe(
        Output.map((jurisdiction) =>
          jurisdiction === "default" ? undefined : jurisdiction,
        ),
      ),
    };
  } else if (isKVNamespace(binding)) {
    return {
      type: "kv_namespace",
      name: bindingName,
      namespaceId: binding.namespaceId,
    };
  } else if (isQueue(binding)) {
    return {
      type: "queue",
      name: bindingName,
      queueName: binding.queueName,
      // Alchemy-only mode discriminator for dev (stripped before upload).
      queueId: binding.queueId,
    };
  } else if (isDispatchNamespace(binding)) {
    return {
      type: "dispatch_namespace",
      name: bindingName,
      namespace: binding.name,
    };
  } else if (isAiGateway(binding)) {
    return {
      type: "ai",
      name: bindingName,
    };
  } else if (isAI(binding)) {
    return {
      type: "ai",
      name: bindingName,
    };
  } else if (isSearchInstance(binding)) {
    // Single-instance binding: `env.NAME` is the instance itself. The
    // `namespace` qualifies which namespace the instance lives in (the
    // account-provided `default` when unspecified).
    return {
      type: "ai_search",
      name: bindingName,
      instanceName: binding.instanceId,
      namespace: binding.namespace,
    };
  } else if (isSearchNamespace(binding)) {
    // Namespace binding: `env.NAME.get(instanceName)` selects an instance
    // within the namespace at runtime.
    return {
      type: "ai_search_namespace",
      name: bindingName,
      namespace: binding.name,
    };
  } else if (isHyperdriveConnection(binding)) {
    return {
      type: "hyperdrive",
      name: bindingName,
      id: binding.hyperdriveId,
    };
  } else if (isWorkerEntrypoint(binding)) {
    // A named-entrypoint service binding (`Cloudflare.WorkerEntrypoint`).
    // Tested BEFORE `isWorker` — the marker carries the Worker rather than
    // being one, but keep the specific classifier ahead of the general one.
    return {
      type: "service",
      name: bindingName,
      service: binding.worker.workerName,
      entrypoint: binding.entrypoint,
      props: binding.props,
    };
  } else if (isWorker(binding)) {
    return {
      type: "service",
      name: bindingName,
      service: binding.workerName,
    };
  } else if (isIndex(binding)) {
    return {
      type: "vectorize",
      name: bindingName,
      indexName: binding.indexName,
    };
  } else if (isSecret(binding)) {
    return {
      type: "secrets_store_secret",
      name: bindingName,
      secretName: binding.secretName,
      storeId: binding.storeId,
    };
  } else if (isVersionMetadata(binding)) {
    return {
      type: "version_metadata",
      name: bindingName,
    };
  } else if (isSelfUrl(binding)) {
    // The Worker's own URL. The provider lowers this sentinel into a
    // `plain_text` binding holding the resolved URL just before upload.
    return {
      type: "self_url",
      name: bindingName,
    };
  } else if (isSelf(binding)) {
    // A service binding to the Worker itself. The provider lowers this
    // sentinel into a `service` binding targeting the Worker's own
    // physical name just before upload.
    return {
      type: "self_service",
      name: bindingName,
    };
  } else if (isWorkerLoader(binding)) {
    return {
      type: "worker_loader",
      name: bindingName,
    };
  } else if (isPipelinesStream(binding)) {
    return {
      type: "pipelines",
      name: bindingName,
      pipeline: binding.streamId,
    };
  } else if (isLegacyPipeline(binding)) {
    return {
      type: "pipelines",
      name: bindingName,
      pipeline: binding.name,
    };
  } else if (Output.isOutput(binding)) {
    return Output.map(
      binding,
      (value: Json | Redacted.Redacted<Json> | VpcServiceLookup) =>
        // A `VpcService.lookup(...)` data source resolves to the service's
        // attributes branded with the resource `Type`; classify it like the
        // managed resource instead of a plain json env value.
        isVpcService(value)
          ? {
              type: "vpc_service" as const,
              name: bindingName,
              serviceId: (value as VpcServiceLookup).serviceId,
            }
          : toValueBinding(
              bindingName,
              value as Json | Redacted.Redacted<Json>,
            ),
    );
  } else {
    return {
      type: "json",
      name: bindingName,
      json: binding,
    };
  }
};

export const getCronBindings = (
  bindings: ReadonlyArray<ResourceBinding<Worker["Binding"]>>,
) => Array.from(new Set(bindings.flatMap((b) => b.data.crons ?? [])));

/**
 * Merge the Workers Cache settings contributed by `yield* Cloudflare.cache()`
 * bindings. Commutative: the cache is enabled (and cross-version) if any
 * contributor asked for it.
 */
export const getCacheBinding = (
  bindings: ReadonlyArray<ResourceBinding<Worker["Binding"]>>,
) => {
  const configs = bindings.flatMap((b) => (b.data.cache ? [b.data.cache] : []));
  if (configs.length === 0) {
    return undefined;
  }
  return {
    enabled: configs.some((c) => c.enabled),
    crossVersionCache: configs.some((c) => c.crossVersionCache) || undefined,
  };
};

const DEFAULT_OBSERVABILITY: WorkerObservability = {
  enabled: true,
  logs: {
    enabled: true,
    invocationLogs: true,
  },
};

/**
 * Resolve the observability metadata to upload. An explicit
 * `news.observability.traces` wins; otherwise the traces contributed by
 * `Cloudflare.Telemetry()` (a single binding row — rows are collapsed by
 * sid) fill in without clobbering the logs config. A cache-style `??` on
 * the whole object would drop the default `logs.invocationLogs`.
 */
export const resolveObservability = (
  news: Pick<WorkerProps, "observability">,
  bindings: ReadonlyArray<ResourceBinding<Worker["Binding"]>>,
): WorkerObservability => {
  const observability = news.observability ?? DEFAULT_OBSERVABILITY;
  const bound = bindings.find((b) => b.data.observability?.traces != null)?.data
    .observability?.traces;
  return observability.traces != null || bound == null
    ? observability
    : { ...observability, traces: bound };
};
