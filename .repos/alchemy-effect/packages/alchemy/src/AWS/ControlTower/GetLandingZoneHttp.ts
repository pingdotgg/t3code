import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { GetLandingZone } from "./GetLandingZone.ts";

export const GetLandingZoneHttp = Layer.effect(
  GetLandingZone,
  makeControlTowerAccountHttpBinding({
    capability: "GetLandingZone",
    iamActions: ["controltower:GetLandingZone"],
    operation: controltower.getLandingZone,
  }),
);
