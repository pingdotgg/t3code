import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { RemoveAutoScalingPolicy } from "./RemoveAutoScalingPolicy.ts";

export const RemoveAutoScalingPolicyHttp = Layer.effect(
  RemoveAutoScalingPolicy,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.RemoveAutoScalingPolicy",
    operation: emr.removeAutoScalingPolicy,
    actions: ["elasticmapreduce:RemoveAutoScalingPolicy"],
  }),
);
