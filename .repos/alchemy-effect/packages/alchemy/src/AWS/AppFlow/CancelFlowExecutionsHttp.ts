import * as appflow from "@distilled.cloud/aws/appflow";
import * as Layer from "effect/Layer";
import { makeAppFlowHttpBinding } from "./BindingHttp.ts";
import { CancelFlowExecutions } from "./CancelFlowExecutions.ts";
import type { Flow } from "./Flow.ts";

export const CancelFlowExecutionsHttp = Layer.effect(
  CancelFlowExecutions,
  makeAppFlowHttpBinding({
    action: "CancelFlowExecutions",
    operation: appflow.cancelFlowExecutions,
    identifier: (flow: Flow) => flow.flowName,
    requestKey: "flowName",
    resources: (flow: Flow) => [flow.flowArn],
  }),
);
