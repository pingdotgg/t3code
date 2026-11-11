import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { RemoveManagedScalingPolicy } from "./RemoveManagedScalingPolicy.ts";

export const RemoveManagedScalingPolicyHttp = Layer.effect(
  RemoveManagedScalingPolicy,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.RemoveManagedScalingPolicy",
    operation: emr.removeManagedScalingPolicy,
    actions: ["elasticmapreduce:RemoveManagedScalingPolicy"],
  }),
);
