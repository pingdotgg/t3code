import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeExecutionScopedHttpBinding } from "./BindingHttp.ts";
import { DescribeMapRun } from "./DescribeMapRun.ts";

export const DescribeMapRunHttp = Layer.effect(
  DescribeMapRun,
  makeExecutionScopedHttpBinding({
    tag: "AWS.StepFunctions.DescribeMapRun",
    operation: sfn.describeMapRun,
    actions: ["states:DescribeMapRun"],
    scope: "mapRun",
  }),
);
