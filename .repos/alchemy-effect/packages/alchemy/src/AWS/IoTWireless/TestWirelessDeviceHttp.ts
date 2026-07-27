import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import {
  TestWirelessDevice,
  type TestWirelessDeviceRequest,
} from "./TestWirelessDevice.ts";

export const TestWirelessDeviceHttp = Layer.effect(
  TestWirelessDevice,
  makeIotWirelessDeviceHttpBinding({
    capability: "TestWirelessDevice",
    iamActions: ["iotwireless:TestWirelessDevice"],
    operation: iotw.testWirelessDevice,
    prepare: (
      request: TestWirelessDeviceRequest | undefined,
      wirelessDeviceId,
    ) => ({
      ...request,
      Id: wirelessDeviceId,
    }),
  }),
);
