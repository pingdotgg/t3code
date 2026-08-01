import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import { makeDocDBElasticAccountHttpBinding } from "./BindingHttp.ts";
import { GetPendingMaintenanceAction } from "./GetPendingMaintenanceAction.ts";

export const GetPendingMaintenanceActionHttp = Layer.effect(
  GetPendingMaintenanceAction,
  makeDocDBElasticAccountHttpBinding({
    tag: "AWS.DocDBElastic.GetPendingMaintenanceAction",
    operation: docdbelastic.getPendingMaintenanceAction,
    actions: ["docdb-elastic:GetPendingMaintenanceAction"],
  }),
);
