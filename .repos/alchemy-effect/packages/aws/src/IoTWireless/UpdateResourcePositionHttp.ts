import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import {
  UpdateResourcePosition,
  type UpdateResourcePositionRequest,
} from "./UpdateResourcePosition.ts";

export const UpdateResourcePositionHttp = Layer.effect(
  UpdateResourcePosition,
  makeIotWirelessDeviceHttpBinding({
    capability: "UpdateResourcePosition",
    iamActions: ["iotwireless:UpdateResourcePosition"],
    // IoT Wireless authorizes the position APIs against a type-level ARN
    // (…:WirelessDevice/WirelessDevice) — the device ARN never matches.
    resourceScope: "any",
    operation: iotw.updateResourcePosition,
    prepare: (request: UpdateResourcePositionRequest, wirelessDeviceId) => ({
      ...request,
      ResourceIdentifier: wirelessDeviceId,
      ResourceType: "WirelessDevice" as const,
    }),
  }),
);
