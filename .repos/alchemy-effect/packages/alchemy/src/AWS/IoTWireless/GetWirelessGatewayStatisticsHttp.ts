import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessGatewayHttpBinding } from "./BindingHttp.ts";
import {
  GetWirelessGatewayStatistics,
  type GetWirelessGatewayStatisticsRequest,
} from "./GetWirelessGatewayStatistics.ts";

export const GetWirelessGatewayStatisticsHttp = Layer.effect(
  GetWirelessGatewayStatistics,
  makeIotWirelessGatewayHttpBinding({
    capability: "GetWirelessGatewayStatistics",
    iamActions: ["iotwireless:GetWirelessGatewayStatistics"],
    operation: iotw.getWirelessGatewayStatistics,
    prepare: (
      request: GetWirelessGatewayStatisticsRequest | undefined,
      wirelessGatewayId,
    ) => ({
      ...request,
      WirelessGatewayId: wirelessGatewayId,
    }),
  }),
);
