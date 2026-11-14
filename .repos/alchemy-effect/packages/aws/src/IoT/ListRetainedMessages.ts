import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

export interface ListRetainedMessagesRequest extends iotdata.ListRetainedMessagesRequest {}

/**
 * Runtime binding for the IoT data-plane `ListRetainedMessages` operation
 * (IAM action `iot:ListRetainedMessages`, granted on `*` — the action does
 * not support resource-level permissions).
 *
 * Returns summaries (topic, payload size, QoS) of all retained MQTT
 * messages in the account; read a payload with
 * {@link GetRetainedMessage}. Provide the implementation with
 * `Effect.provide(AWS.IoT.ListRetainedMessagesHttp)`.
 * ### Retained Messages
 * **Example:** List Retained Topics
 * ```typescript
 * const listRetained = yield* AWS.IoT.ListRetainedMessages();
 *
 * const { retainedTopics } = yield* listRetained();
 * ```
 *
 * @binding
 */
export interface ListRetainedMessages extends Binding.Service<
  ListRetainedMessages,
  "AWS.IoT.ListRetainedMessages",
  () => Effect.Effect<
    (
      request?: ListRetainedMessagesRequest,
    ) => Effect.Effect<iotdata.ListRetainedMessagesResponse, iotdata.ListRetainedMessagesError>
  >
> {}

export const ListRetainedMessages = Binding.Service<ListRetainedMessages>(
  "AWS.IoT.ListRetainedMessages",
);
