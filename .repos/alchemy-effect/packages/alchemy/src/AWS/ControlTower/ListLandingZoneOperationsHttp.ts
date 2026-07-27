import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { ListLandingZoneOperations } from "./ListLandingZoneOperations.ts";

export const ListLandingZoneOperationsHttp = Layer.effect(
  ListLandingZoneOperations,
  makeControlTowerAccountHttpBinding({
    capability: "ListLandingZoneOperations",
    iamActions: ["controltower:ListLandingZoneOperations"],
    operation: controltower.listLandingZoneOperations,
  }),
);
