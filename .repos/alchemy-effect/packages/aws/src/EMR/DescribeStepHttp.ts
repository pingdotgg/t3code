import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeStep } from "./DescribeStep.ts";

export const DescribeStepHttp = Layer.effect(
  DescribeStep,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.DescribeStep",
    operation: emr.describeStep,
    actions: ["elasticmapreduce:DescribeStep"],
  }),
);
