import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { ListEnabledBaselines } from "./ListEnabledBaselines.ts";

export const ListEnabledBaselinesHttp = Layer.effect(
  ListEnabledBaselines,
  makeControlTowerAccountHttpBinding({
    capability: "ListEnabledBaselines",
    iamActions: ["controltower:ListEnabledBaselines"],
    operation: controltower.listEnabledBaselines,
  }),
);
