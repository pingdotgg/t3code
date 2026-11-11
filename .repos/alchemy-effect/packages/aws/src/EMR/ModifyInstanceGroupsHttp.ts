import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { ModifyInstanceGroups } from "./ModifyInstanceGroups.ts";

export const ModifyInstanceGroupsHttp = Layer.effect(
  ModifyInstanceGroups,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.ModifyInstanceGroups",
    operation: emr.modifyInstanceGroups,
    actions: ["elasticmapreduce:ModifyInstanceGroups"],
  }),
);
