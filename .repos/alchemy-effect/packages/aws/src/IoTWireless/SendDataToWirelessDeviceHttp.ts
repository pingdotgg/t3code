import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import {
  SendDataToWirelessDevice,
  type SendDataToWirelessDeviceRequest,
} from "./SendDataToWirelessDevice.ts";

export const SendDataToWirelessDeviceHttp = Layer.effect(
  SendDataToWirelessDevice,
  makeIotWirelessDeviceHttpBinding({
    capability: "SendDataToWirelessDevice",
    iamActions: ["iotwireless:SendDataToWirelessDevice"],
    operation: iotw.sendDataToWirelessDevice,
    prepare: (request: SendDataToWirelessDeviceRequest, wirelessDeviceId) => ({
      ...request,
      Id: wirelessDeviceId,
    }),
  }),
);
