import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Namespace from "../Namespace.ts";
import { ProviderModePolicy } from "../ProviderMode.ts";
import { Function } from "./Function.ts";
import { FunctionRequest } from "./FunctionEnvironment.ts";
import { FunctionTrigger } from "./FunctionTrigger.ts";
import type { Bucket } from "./Bucket.ts";
import {
  BucketEventSource,
  type BucketEventSourceProps,
  type BucketEventSourceService,
} from "./BucketEventSource.ts";
import {
  decodeFunctionTriggerEvent,
  type BucketEvent,
} from "./FunctionTriggerEvent.ts";

/**
 * Neon Function HTTP object-event dispatch and deployment wiring.
 *
 * ### Subscribe to uploads
 * **Example:** Provide the subscription implementation
 * ```typescript
 * const application = Effect.gen(function* () {
 *   yield* Neon.BucketEventSource(uploads, { name: "Uploads" }, event =>
 *     Effect.log(event.objectKey),
 *   );
 *   return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 * }).pipe(Effect.provide(Neon.BucketEventSourceHttp));
 * ```
 *
 * @layer
 * @product Bucket
 * @provides Neon.BucketEventSource
 */
export const BucketEventSourceHttp = Layer.effect(
  BucketEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    const Trigger = yield* FunctionTrigger;
    return Effect.fn(function* (
      bucket: Bucket,
      props: BucketEventSourceProps,
      handler: (event: BucketEvent) => Effect.Effect<void, unknown>,
    ) {
      const path = `/__alchemy/neon/bucket/${encodeURIComponent(props.name)}`;
      const triggerName = `${host.FQN}:${props.name}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const context = yield* AlchemyContext;
        const remote = yield* ProviderModePolicy;
        if (!context.dev || remote)
          yield* Namespace.push(
            host.LogicalId,
            Trigger(props.name, {
              function: host,
              type: "storage_object_created",
              name: triggerName,
              storageObjectCreated: { bucket, prefix: props.prefix },
              path,
              enabled: props.enabled,
            }),
          );
      }
      const bucketName = yield* bucket.bucketName;
      yield* host.route(
        path,
        Effect.gen(function* () {
          const event = yield* decodeFunctionTriggerEvent(
            yield* FunctionRequest,
          );
          if (
            event.trigger.type !== "storage_object_created" ||
            event.trigger.name !== triggerName ||
            !("bucket_name" in event.data) ||
            event.data.bucket_name !== (yield* bucketName) ||
            (props.prefix && !event.data.object_key.startsWith(props.prefix))
          )
            return HttpServerResponse.empty({ status: 400 });
          yield* handler({
            invocationId: event.invocation_id,
            triggerId: event.trigger.id,
            name: props.name,
            bucketName: event.data.bucket_name,
            objectKey: event.data.object_key,
          }).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }).pipe(
          Effect.catchTag("FunctionTriggerEventError", (error) =>
            Effect.succeed(HttpServerResponse.empty({ status: error.status })),
          ),
        ),
      );
    }) as BucketEventSourceService;
  }),
);
