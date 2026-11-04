import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { ListBaselines } from "./ListBaselines.ts";

export const ListBaselinesHttp = Layer.effect(
  ListBaselines,
  makeControlTowerAccountHttpBinding({
    capability: "ListBaselines",
    iamActions: ["controltower:ListBaselines"],
    operation: controltower.listBaselines,
  }),
);
