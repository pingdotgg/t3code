import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { AddInstanceGroups } from "./AddInstanceGroups.ts";

export const AddInstanceGroupsHttp = Layer.effect(
  AddInstanceGroups,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.AddInstanceGroups",
    operation: emr.addInstanceGroups,
    actions: ["elasticmapreduce:AddInstanceGroups"],
    inject: "JobFlowId",
  }),
);
