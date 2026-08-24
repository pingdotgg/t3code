import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { isYieldableEffectLike } from "../../Util/effect.ts";
import { isAiGateway } from "../AI/Gateway.ts";
import { isSearchInstance } from "../AI/SearchInstance.ts";
import { isSearchNamespace } from "../AI/SearchNamespace.ts";
import { isDataset } from "../AnalyticsEngine/Dataset.ts";
import { isNamespace } from "../Artifacts/Namespace.ts";
import { isDatabase } from "../D1/Database.ts";
import { isSendEmail } from "../Email/SendEmail.ts";
import { isApp } from "../Flagship/App.ts";
import { getHyperdriveDevOrigin } from "../Hyperdrive/ConnectBinding.ts";
import { isHyperdriveConnection } from "../Hyperdrive/Connection.ts";
import { isImages } from "../Images/Images.ts";
import { isNamespace as isKVNamespace } from "../KV/Namespace.ts";
import { isQueue } from "../Queues/Queue.ts";
import { isBucket } from "../R2/Bucket.ts";
import { isSecret } from "../SecretsStore/Secret.ts";
import { isIndex } from "../Vectorize/VectorizeIndex.ts";
import { isDispatchNamespace } from "../WorkersForPlatforms/DispatchNamespace.ts";
import { isWorkflowLike, WorkflowResource } from "../Workflows/Workflow.ts";
import { makeWorkflowName } from "../Workflows/WorkflowName.ts";
import { isAI } from "./AI.ts";
import { isAssets } from "./Assets.ts";
import { isBrowser } from "./Browser.ts";
import {
  isDurableObjectLike,
  normalizeTransferredFrom,
} from "./DurableObject.ts";
import { isRateLimit } from "./RateLimit.ts";
import { isVersionMetadata } from "./VersionMetadata.ts";
import type { WorkerBindingProps } from "./Worker.ts";
import { isWorker, type Worker, type WorkerProps } from "./Worker.ts";
import type { WorkerBinding, WorkerBindingResource } from "./WorkerBinding.ts";
import { isWorkerLoader } from "./WorkerLoader.ts";

export const bindWorkerAsyncBindings = Effect.fn(function* (
  resource: Worker,
  props: InputProps<WorkerProps<WorkerBindingProps>>,
) {
  if (props.env) {
    for (const bindingName in props.env) {
      // @ts-expect-error
      const bindingEff = props.env?.[bindingName] as
        | WorkerBindingResource
        | Effect.Effect<WorkerBindingResource>;
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

      let bindingMeta: InputProps<WorkerBinding> | undefined = toBinding(
        bindingName,
        binding,
      );

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
            });
          }
        }

        yield* resource.bind`${bindingName}`({
          bindings: [resolvedBindingMeta],
          hyperdrives: isHyperdriveConnection(binding)
            ? getHyperdriveDevOrigin(binding)
            : undefined,
        });
      } else {
        return yield* Effect.die(`Unknown binding type: ${bindingName}`);
      }
    }
  }
});

type BindingSpec = InputProps<WorkerBinding>;

const toBinding = (
  bindingName: string,
  binding: WorkerBindingResource,
): BindingSpec => {
  if (typeof binding === "string") {
    return {
      type: "plain_text",
      name: bindingName,
      text: binding,
    };
  } else if (Redacted.isRedacted(binding)) {
    const val = Redacted.value(binding);
    if (typeof val === "string") {
      return {
        type: "secret_text",
        name: bindingName,
        text: val,
      };
    } else {
      return {
        type: "secret_text",
        name: bindingName,
        text: JSON.stringify(val),
      };
    }
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
  } else if (isWorkerLoader(binding)) {
    return {
      type: "worker_loader",
      name: bindingName,
    };
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
