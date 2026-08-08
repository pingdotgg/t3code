import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeExecutionScopedHttpBinding } from "./BindingHttp.ts";
import { DescribeExecution } from "./DescribeExecution.ts";

export const DescribeExecutionHttp = Layer.effect(
  DescribeExecution,
  makeExecutionScopedHttpBinding({
    tag: "AWS.StepFunctions.DescribeExecution",
    operation: sfn.describeExecution,
    actions: ["states:DescribeExecution"],
  }),
);
