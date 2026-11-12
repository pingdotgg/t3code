import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribePendingMaintenanceActions } from "./DescribePendingMaintenanceActions.ts";

export const DescribePendingMaintenanceActionsHttp = Layer.effect(
  DescribePendingMaintenanceActions,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DescribePendingMaintenanceActions",
    operation: rds.describePendingMaintenanceActions,
    actions: ["rds:DescribePendingMaintenanceActions"],
  }),
);
