import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";
import { DescribePendingMaintenanceActions } from "./DescribePendingMaintenanceActions.ts";

export const DescribePendingMaintenanceActionsHttp = Layer.effect(
  DescribePendingMaintenanceActions,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.DescribePendingMaintenanceActions",
    operation: neptune.describePendingMaintenanceActions,
    actions: ["rds:DescribePendingMaintenanceActions"],
  }),
);
