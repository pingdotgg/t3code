import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import {
  DeleteQueuedMessages,
  type DeleteQueuedMessagesRequest,
} from "./DeleteQueuedMessages.ts";

export const DeleteQueuedMessagesHttp = Layer.effect(
  DeleteQueuedMessages,
  makeIotWirelessDeviceHttpBinding({
    capability: "DeleteQueuedMessages",
    iamActions: ["iotwireless:DeleteQueuedMessages"],
    operation: iotw.deleteQueuedMessages,
    prepare: (request: DeleteQueuedMessagesRequest, wirelessDeviceId) => ({
      ...request,
      Id: wirelessDeviceId,
    }),
  }),
);
