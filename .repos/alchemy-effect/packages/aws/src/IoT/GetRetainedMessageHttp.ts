import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotTopicHttpBinding } from "./BindingHttp.ts";
import { GetRetainedMessage } from "./GetRetainedMessage.ts";

/**
 * HTTP implementation of the {@link GetRetainedMessage} capability — grants
 * `iot:GetRetainedMessage` on the bound topic filter and calls the IoT
 * data-plane `GetRetainedMessage` API.
 */
export const GetRetainedMessageHttp = Layer.effect(
  GetRetainedMessage,
  makeIotTopicHttpBinding({
    tag: "AWS.IoT.GetRetainedMessage",
    operation: iotdata.getRetainedMessage,
    actions: ["iot:GetRetainedMessage"],
  }),
);
