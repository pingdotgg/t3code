import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { PutAutoScalingPolicy } from "./PutAutoScalingPolicy.ts";

export const PutAutoScalingPolicyHttp = Layer.effect(
  PutAutoScalingPolicy,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.PutAutoScalingPolicy",
    operation: emr.putAutoScalingPolicy,
    actions: ["elasticmapreduce:PutAutoScalingPolicy"],
  }),
);
