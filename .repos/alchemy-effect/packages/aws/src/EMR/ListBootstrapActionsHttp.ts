import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { ListBootstrapActions } from "./ListBootstrapActions.ts";

export const ListBootstrapActionsHttp = Layer.effect(
  ListBootstrapActions,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.ListBootstrapActions",
    operation: emr.listBootstrapActions,
    actions: ["elasticmapreduce:ListBootstrapActions"],
  }),
);
