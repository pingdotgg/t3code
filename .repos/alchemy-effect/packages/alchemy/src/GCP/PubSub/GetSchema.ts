import type * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Schema } from "./Schema.ts";

export interface GetSchemaRequest extends Omit<
  pubsub.GetProjectsSchemasRequest,
  "name"
> {}

/**
 * Runtime binding for Pub/Sub `schemas.get`.
 *
 * Bind this operation to a {@link Schema} in a Function/Action init phase.
 * Provide {@link GetSchemaHttp}.
 *
 * ### Reading a Schema
 * **Example:** Get the latest revision
 * ```typescript
 * const getSchema = yield* GCP.PubSub.GetSchema(schema);
 * const live = yield* getSchema({ view: "FULL" });
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface GetSchema extends Binding.Service<
  GetSchema,
  "GCP.PubSub.GetSchema",
  (
    schema: Schema,
  ) => Effect.Effect<
    (
      request?: GetSchemaRequest,
    ) => Effect.Effect<
      pubsub.Pubsub_Schema,
      pubsub.GetProjectsSchemasError,
      RuntimeContext
    >
  >
> {}

export const GetSchema = Binding.Service<GetSchema>("GCP.PubSub.GetSchema");
