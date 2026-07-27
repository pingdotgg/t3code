import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import {
  GetWirelessDeviceStatistics,
  type GetWirelessDeviceStatisticsRequest,
} from "./GetWirelessDeviceStatistics.ts";

export const GetWirelessDeviceStatisticsHttp = Layer.effect(
  GetWirelessDeviceStatistics,
  makeIotWirelessDeviceHttpBinding({
    capability: "GetWirelessDeviceStatistics",
    iamActions: ["iotwireless:GetWirelessDeviceStatistics"],
    operation: iotw.getWirelessDeviceStatistics,
    prepare: (
      request: GetWirelessDeviceStatisticsRequest | undefined,
      wirelessDeviceId,
    ) => ({
      ...request,
      WirelessDeviceId: wirelessDeviceId,
    }),
  }),
);
