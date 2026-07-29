import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { ApplyPendingMaintenanceAction } from "./ApplyPendingMaintenanceAction.ts";
import { makeDocDBAccountHttpBinding } from "./BindingHttp.ts";

export const ApplyPendingMaintenanceActionHttp = Layer.effect(
  ApplyPendingMaintenanceAction,
  makeDocDBAccountHttpBinding({
    tag: "AWS.DocDB.ApplyPendingMaintenanceAction",
    operation: docdb.applyPendingMaintenanceAction,
    actions: ["rds:ApplyPendingMaintenanceAction"],
  }),
);
