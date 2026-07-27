import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessAccountHttpBinding } from "./BindingHttp.ts";
import { GetServiceEndpoint } from "./GetServiceEndpoint.ts";

export const GetServiceEndpointHttp = Layer.effect(
  GetServiceEndpoint,
  makeIotWirelessAccountHttpBinding({
    capability: "GetServiceEndpoint",
    iamActions: ["iotwireless:GetServiceEndpoint"],
    operation: iotw.getServiceEndpoint,
    prepare: (request: iotw.GetServiceEndpointRequest | undefined) =>
      request ?? {},
  }),
);
