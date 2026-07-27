import * as appflow from "@distilled.cloud/aws/appflow";
import * as Layer from "effect/Layer";
import { makeAppFlowHttpBinding } from "./BindingHttp.ts";
import { DescribeFlowExecutionRecords } from "./DescribeFlowExecutionRecords.ts";
import type { Flow } from "./Flow.ts";

export const DescribeFlowExecutionRecordsHttp = Layer.effect(
  DescribeFlowExecutionRecords,
  makeAppFlowHttpBinding({
    action: "DescribeFlowExecutionRecords",
    operation: appflow.describeFlowExecutionRecords,
    identifier: (flow: Flow) => flow.flowName,
    requestKey: "flowName",
    resources: (flow: Flow) => [flow.flowArn],
  }),
);
