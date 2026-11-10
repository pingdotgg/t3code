import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerHttpBinding } from "./BindingHttp.ts";
import type { LandingZone } from "./LandingZone.ts";
import { ResetLandingZone } from "./ResetLandingZone.ts";

export const ResetLandingZoneHttp = Layer.effect(
  ResetLandingZone,
  makeControlTowerHttpBinding({
    capability: "ResetLandingZone",
    iamActions: ["controltower:ResetLandingZone"],
    requestKey: "landingZoneIdentifier",
    identifier: (landingZone: LandingZone) => landingZone.landingZoneArn,
    operation: controltower.resetLandingZone,
  }),
);
