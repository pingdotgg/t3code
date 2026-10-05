import * as ai from "@distilled.cloud/cloudflare/ai";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export interface ModelProps {
  /** Cloudflare-managed model name, such as `@cf/baai/bge-m3`. */
  modelName: string;
}

export interface ModelAttributes {
  /** Account used to validate and subscribe to the model. */
  accountId: string;
  /** Cloudflare-managed model name. */
  modelName: string;
}

export type Model = Resource<
  "Cloudflare.AI.Model",
  ModelProps,
  ModelAttributes,
  never,
  Providers
>;

/**
 * A persisted, non-owning handle to a Cloudflare Workers AI catalog model.
 *
 * Deployment validates the model through its schema endpoint and records its
 * name and account in Alchemy state. It does not provision or invoke a model.
 * Destruction removes only the handle from state; Cloudflare owns the model.
 *
 * ### Selecting a Model
 * **Example:** Observe a Workers AI model
 * ```typescript
 * const model = yield* Cloudflare.AI.Model("Embeddings", {
 *   modelName: "@cf/baai/bge-m3",
 * });
 * ```
 *
 * ### Subscribing to Batch Events
 * **Example:** Model-specific Queue subscription
 * ```typescript
 * const model = yield* Cloudflare.AI.Model("Embeddings", {
 *   modelName: "@cf/baai/bge-m3",
 * });
 * const queue = yield* Cloudflare.Queues.Queue("BatchEvents");
 * yield* Cloudflare.Queues.Subscription("ModelEvents", {
 *   source: model,
 *   events: ["batch.queued", "batch.succeeded", "batch.failed"],
 *   queueId: queue.queueId,
 * });
 * ```
 * These events require asynchronous batch inference. Synchronous inference
 * does not emit batch events.
 *
 * ### Referencing a Persisted Handle
 * **Example:** Read a model handle from another stack
 * ```typescript
 * const model = yield* Cloudflare.AI.Model.ref("Embeddings", {
 *   stack: "models",
 *   stage: "production",
 * });
 * ```
 * The handle must already be deployed. A reference neither invokes the model
 * nor takes ownership of the source stack's state.
 *
 * @resource
 * @product Workers AI
 * @category AI
 */
export const Model = Resource<Model>("Cloudflare.AI.Model");

const observeModel = (accountId: string, modelName: string) =>
  ai
    .getModelSchema({ accountId, model: modelName })
    .pipe(Effect.as({ accountId, modelName }));

export const ModelProvider = () =>
  Provider.succeed(Model, {
    stables: ["accountId", "modelName"],
    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (
        (output && accountId !== output.accountId) ||
        !isResolved(news) ||
        (output && news.modelName !== output.modelName)
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const modelName = output?.modelName ?? olds?.modelName;
      return modelName === undefined
        ? undefined
        : yield* observeModel(output?.accountId ?? accountId, modelName);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* observeModel(accountId, news.modelName);
    }),
    delete: () => Effect.void,
  });
