import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessAccountHttpBinding } from "./BindingHttp.ts";
import { GetPositionEstimate } from "./GetPositionEstimate.ts";

export const GetPositionEstimateHttp = Layer.effect(
  GetPositionEstimate,
  makeIotWirelessAccountHttpBinding({
    capability: "GetPositionEstimate",
    iamActions: ["iotwireless:GetPositionEstimate"],
    operation: iotw.getPositionEstimate,
    prepare: (request: iotw.GetPositionEstimateRequest) => request,
  }),
);
