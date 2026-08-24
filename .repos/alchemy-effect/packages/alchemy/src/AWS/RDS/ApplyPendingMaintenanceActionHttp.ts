import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { ApplyPendingMaintenanceAction } from "./ApplyPendingMaintenanceAction.ts";

export const ApplyPendingMaintenanceActionHttp = Layer.effect(
  ApplyPendingMaintenanceAction,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.ApplyPendingMaintenanceAction",
    operation: rds.applyPendingMaintenanceAction,
    actions: ["rds:ApplyPendingMaintenanceAction"],
  }),
);
