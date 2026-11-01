import type * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Schema } from "./Schema.ts";

export interface ValidateMessageRequest extends Omit<
  pubsub.ValidateMessageRequest,
  "name" | "schema"
> {}

/**
 * Runtime binding for Pub/Sub `schemas.validateMessage`.
 *
 * Bind this operation to a {@link Schema} in a Function/Action init phase.
 * Provide {@link ValidateMessageHttp}.
 *
 * Grants `roles/pubsub.viewer` on the project: `schemas.validateMessage` is
 * authorized on the parent project, and a grant on the schema's own IAM
 * policy is not enough.
 *
 * ### Validating Messages
 * **Example:** Validate a JSON-encoded Avro payload
 * ```typescript
 * const validate = yield* GCP.PubSub.ValidateMessage(schema);
 * yield* validate({
 *   encoding: "JSON",
 *   message: btoa(JSON.stringify({ id: "abc" })),
 * });
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface ValidateMessage extends Binding.Service<
  ValidateMessage,
  "GCP.PubSub.ValidateMessage",
  (
    schema: Schema,
  ) => Effect.Effect<
    (
      request: ValidateMessageRequest,
    ) => Effect.Effect<
      pubsub.ValidateMessageResponse,
      pubsub.ValidateMessageProjectsSchemasError,
      RuntimeContext
    >
  >
> {}

export const ValidateMessage = Binding.Service<ValidateMessage>(
  "GCP.PubSub.ValidateMessage",
);
