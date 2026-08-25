import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { AddJobFlowSteps } from "./AddJobFlowSteps.ts";

export const AddJobFlowStepsHttp = Layer.effect(
  AddJobFlowSteps,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.AddJobFlowSteps",
    operation: emr.addJobFlowSteps,
    actions: ["elasticmapreduce:AddJobFlowSteps"],
    inject: "JobFlowId",
  }),
);
