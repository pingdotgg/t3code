import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import {
  ListQueuedMessages,
  type ListQueuedMessagesRequest,
} from "./ListQueuedMessages.ts";

export const ListQueuedMessagesHttp = Layer.effect(
  ListQueuedMessages,
  makeIotWirelessDeviceHttpBinding({
    capability: "ListQueuedMessages",
    iamActions: ["iotwireless:ListQueuedMessages"],
    operation: iotw.listQueuedMessages,
    prepare: (
      request: ListQueuedMessagesRequest | undefined,
      wirelessDeviceId,
    ) => ({
      ...request,
      Id: wirelessDeviceId,
    }),
  }),
);
