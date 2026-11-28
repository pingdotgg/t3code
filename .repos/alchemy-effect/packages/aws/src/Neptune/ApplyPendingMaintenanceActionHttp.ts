import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { ApplyPendingMaintenanceAction } from "./ApplyPendingMaintenanceAction.ts";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";

export const ApplyPendingMaintenanceActionHttp = Layer.effect(
  ApplyPendingMaintenanceAction,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.ApplyPendingMaintenanceAction",
    operation: neptune.applyPendingMaintenanceAction,
    actions: ["rds:ApplyPendingMaintenanceAction"],
  }),
);
