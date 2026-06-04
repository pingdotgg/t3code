import type { PutScriptRequest } from "@distilled.cloud/cloudflare/workers";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { isYieldableEffectLike } from "../../Util/effect.ts";
import { asEffect } from "../../Util/types.ts";
import { isAiGateway } from "../AiGateway/AiGateway.ts";
import { isAnalyticsEngineDataset } from "../AnalyticsEngine/AnalyticsEngineDataset.ts";
import { isArtifacts } from "../Artifacts/Artifacts.ts";
import { isBrowser } from "../Browser/Browser.ts";
import { isD1Database } from "../D1/D1Database.ts";
import { isSendEmail } from "../Email/SendEmail.ts";
import { isHyperdrive } from "../Hyperdrive/Hyperdrive.ts";
import { getHyperdriveDevOrigin } from "../Hyperdrive/HyperdriveBinding.ts";
import { isImages } from "../Images/Images.ts";
import { isKVNamespace } from "../KV/KVNamespace.ts";
import { isQueue } from "../Queue/Queue.ts";
import { isR2Bucket } from "../R2/R2Bucket.ts";
import { isRateLimit } from "../RateLimit/RateLimit.ts";
import { isVectorizeIndex } from "../Vectorize/VectorizeIndex.ts";
import { isAssets } from "./Assets.ts";
import { isDurableObjectNamespaceLike } from "./DurableObjectNamespace.ts";
import { isDynamicWorkerLoader } from "./DynamicWorkerLoader.ts";
import type { WorkerBindingProps } from "./Worker.ts";
import { isWorker, type Worker, type WorkerProps } from "./Worker.ts";
import type { WorkerBinding, WorkerBindingResource } from "./WorkerBinding.ts";

export const bindWorkerAsyncBindings = Effect.fnUntraced(function* (
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
      const binding = isYieldableEffectLike(bindingEff)
        ? ((yield* bindingEff as Effect.Effect<unknown>) as WorkerBindingResource)
        : bindingEff;

      const bindingMeta: InputProps<WorkerBinding> | undefined =
        yield* asEffect(toBinding(bindingName, binding));

      if (bindingMeta) {
        yield* resource.bind`${bindingName}`({
          bindings: [bindingMeta],
          hyperdrives: isHyperdrive(binding)
            ? getHyperdriveDevOrigin(binding)
            : undefined,
        });
      } else {
        return yield* Effect.die(`Unknown binding type: ${bindingName}`);
      }
    }
  }
});

type BindingSpec = InputProps<
  Exclude<PutScriptRequest["metadata"]["bindings"], undefined>[number]
>;

const toBinding = (
  bindingName: string,
  binding: WorkerBindingResource,
): BindingSpec | Effect.Effect<BindingSpec> | undefined => {
  // narrowing to Config<unknown> doesn't work for us, we need any
  const isConfig: (a: any) => a is Config.Config<any> = Config.isConfig;
  // narrowing to Redacted<unknown> doesn't work for us, we need any
  const isRedacted: (a: any) => a is Redacted.Redacted<any> =
    Redacted.isRedacted;

  if (typeof binding === "string") {
    return {
      type: "plain_text",
      name: bindingName,
      text: binding,
    };
  } else if (isRedacted(binding)) {
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
  } else if (isConfig(binding)) {
    return binding.pipe(
      Effect.flatMap((json) => {
        const b = toBinding(bindingName, json)!;
        return Effect.isEffect(b) ? b : Effect.succeed(b);
      }),
      Effect.orDie,
    );
  } else if (isAssets(binding)) {
    return {
      type: "assets",
      name: bindingName,
    };
  } else if (isArtifacts(binding)) {
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
  } else if (isAnalyticsEngineDataset(binding)) {
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
  } else if (isDurableObjectNamespaceLike(binding)) {
    return {
      type: "durable_object_namespace",
      name: bindingName,
      className: binding.className ?? binding.name,
      scriptName: binding.scriptName,
    };
  } else if (isD1Database(binding)) {
    return {
      type: "d1",
      databaseId: binding.databaseId,
      name: bindingName,
    };
  } else if (isR2Bucket(binding)) {
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
  } else if (isAiGateway(binding)) {
    return {
      type: "ai",
      name: bindingName,
    };
  } else if (isHyperdrive(binding)) {
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
  } else if (isVectorizeIndex(binding)) {
    return {
      type: "vectorize",
      name: bindingName,
      indexName: binding.indexName,
    };
  } else if (isDynamicWorkerLoader(binding)) {
    return {
      type: "worker_loader",
      name: bindingName,
    } as any;
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
