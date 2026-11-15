import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { GetManagedScalingPolicy } from "./GetManagedScalingPolicy.ts";

export const GetManagedScalingPolicyHttp = Layer.effect(
  GetManagedScalingPolicy,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.GetManagedScalingPolicy",
    operation: emr.getManagedScalingPolicy,
    actions: ["elasticmapreduce:GetManagedScalingPolicy"],
  }),
);
