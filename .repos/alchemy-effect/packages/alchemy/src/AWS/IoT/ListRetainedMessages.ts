import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListRetainedMessagesRequest
  extends iotdata.ListRetainedMessagesRequest {}

/**
 * Runtime binding for the IoT data-plane `ListRetainedMessages` operation
 * (IAM action `iot:ListRetainedMessages`, granted on `*` — the action does
 * not support resource-level permissions).
 *
 * Returns summaries (topic, payload size, QoS) of all retained MQTT
 * messages in the account; read a payload with
 * {@link GetRetainedMessage}. Provide the implementation with
 * `Effect.provide(AWS.IoT.ListRetainedMessagesHttp)`.
 * @binding
 * @section Retained Messages
 * @example List Retained Topics
 * ```typescript
 * const listRetained = yield* AWS.IoT.ListRetainedMessages();
 *
 * const { retainedTopics } = yield* listRetained();
 * ```
 */
export interface ListRetainedMessages extends Binding.Service<
  ListRetainedMessages,
  "AWS.IoT.ListRetainedMessages",
  () => Effect.Effect<
    (
      request?: ListRetainedMessagesRequest,
    ) => Effect.Effect<
      iotdata.ListRetainedMessagesResponse,
      iotdata.ListRetainedMessagesError
    >
  >
> {}

export const ListRetainedMessages = Binding.Service<ListRetainedMessages>(
  "AWS.IoT.ListRetainedMessages",
);
