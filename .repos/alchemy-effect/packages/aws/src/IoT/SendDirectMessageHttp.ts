import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotClientHttpBinding } from "./BindingHttp.ts";
import { SendDirectMessage } from "./SendDirectMessage.ts";

/**
 * HTTP implementation of the {@link SendDirectMessage} capability — grants
 * `iot:SendDirectMessage` on the bound client filter and calls the IoT
 * data-plane `SendDirectMessage` API.
 */
export const SendDirectMessageHttp = Layer.effect(
  SendDirectMessage,
  makeIotClientHttpBinding({
    tag: "AWS.IoT.SendDirectMessage",
    operation: iotdata.sendDirectMessage,
    actions: ["iot:SendDirectMessage"],
  }),
);
