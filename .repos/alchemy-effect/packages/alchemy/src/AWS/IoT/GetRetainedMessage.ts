import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetRetainedMessageRequest
  extends iotdata.GetRetainedMessageRequest {}

/**
 * Runtime binding for the IoT data-plane `GetRetainedMessage` operation (IAM
 * action `iot:GetRetainedMessage`).
 *
 * Binding to a topic filter grants `iot:GetRetainedMessage` on matching
 * topics (or all topics when the filter is omitted) and returns a callable
 * that reads the retained MQTT message for a concrete topic. Provide the
 * implementation with `Effect.provide(AWS.IoT.GetRetainedMessageHttp)`.
 * @binding
 * @section Retained Messages
 * @example Read a Retained Message
 * ```typescript
 * const getRetained = yield* AWS.IoT.GetRetainedMessage("sensors/*");
 *
 * const { payload } = yield* getRetained({ topic: "sensors/1/state" });
 * ```
 */
export interface GetRetainedMessage extends Binding.Service<
  GetRetainedMessage,
  "AWS.IoT.GetRetainedMessage",
  (
    topicFilter?: string,
  ) => Effect.Effect<
    (
      request: GetRetainedMessageRequest,
    ) => Effect.Effect<
      iotdata.GetRetainedMessageResponse,
      iotdata.GetRetainedMessageError
    >
  >
> {}

export const GetRetainedMessage = Binding.Service<GetRetainedMessage>(
  "AWS.IoT.GetRetainedMessage",
);
