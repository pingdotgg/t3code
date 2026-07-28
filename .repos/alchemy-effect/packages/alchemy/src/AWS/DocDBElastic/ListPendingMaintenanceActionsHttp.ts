import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import { makeDocDBElasticAccountHttpBinding } from "./BindingHttp.ts";
import { ListPendingMaintenanceActions } from "./ListPendingMaintenanceActions.ts";

export const ListPendingMaintenanceActionsHttp = Layer.effect(
  ListPendingMaintenanceActions,
  makeDocDBElasticAccountHttpBinding({
    tag: "AWS.DocDBElastic.ListPendingMaintenanceActions",
    operation: docdbelastic.listPendingMaintenanceActions,
    actions: ["docdb-elastic:ListPendingMaintenanceActions"],
  }),
);
