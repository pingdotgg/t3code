import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { GetLandingZoneOperation } from "./GetLandingZoneOperation.ts";

export const GetLandingZoneOperationHttp = Layer.effect(
  GetLandingZoneOperation,
  makeControlTowerAccountHttpBinding({
    capability: "GetLandingZoneOperation",
    iamActions: ["controltower:GetLandingZoneOperation"],
    operation: controltower.getLandingZoneOperation,
  }),
);
