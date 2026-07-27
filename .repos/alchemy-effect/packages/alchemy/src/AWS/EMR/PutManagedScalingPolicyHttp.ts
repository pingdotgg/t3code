import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { PutManagedScalingPolicy } from "./PutManagedScalingPolicy.ts";

export const PutManagedScalingPolicyHttp = Layer.effect(
  PutManagedScalingPolicy,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.PutManagedScalingPolicy",
    operation: emr.putManagedScalingPolicy,
    actions: ["elasticmapreduce:PutManagedScalingPolicy"],
  }),
);
