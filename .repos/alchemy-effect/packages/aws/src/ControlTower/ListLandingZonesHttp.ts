import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { ListLandingZones } from "./ListLandingZones.ts";

export const ListLandingZonesHttp = Layer.effect(
  ListLandingZones,
  makeControlTowerAccountHttpBinding({
    capability: "ListLandingZones",
    iamActions: ["controltower:ListLandingZones"],
    operation: controltower.listLandingZones,
  }),
);
