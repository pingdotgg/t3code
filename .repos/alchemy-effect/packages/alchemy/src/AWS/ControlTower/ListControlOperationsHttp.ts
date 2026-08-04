import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { ListControlOperations } from "./ListControlOperations.ts";

export const ListControlOperationsHttp = Layer.effect(
  ListControlOperations,
  makeControlTowerAccountHttpBinding({
    capability: "ListControlOperations",
    iamActions: ["controltower:ListControlOperations"],
    operation: controltower.listControlOperations,
  }),
);
