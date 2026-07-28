import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { GetBaselineOperation } from "./GetBaselineOperation.ts";

export const GetBaselineOperationHttp = Layer.effect(
  GetBaselineOperation,
  makeControlTowerAccountHttpBinding({
    capability: "GetBaselineOperation",
    iamActions: ["controltower:GetBaselineOperation"],
    operation: controltower.getBaselineOperation,
  }),
);
