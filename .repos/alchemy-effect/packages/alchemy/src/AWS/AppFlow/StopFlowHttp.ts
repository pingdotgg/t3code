import * as appflow from "@distilled.cloud/aws/appflow";
import * as Layer from "effect/Layer";
import { makeAppFlowHttpBinding } from "./BindingHttp.ts";
import type { Flow } from "./Flow.ts";
import { StopFlow } from "./StopFlow.ts";

export const StopFlowHttp = Layer.effect(
  StopFlow,
  makeAppFlowHttpBinding({
    action: "StopFlow",
    operation: appflow.stopFlow,
    identifier: (flow: Flow) => flow.flowName,
    requestKey: "flowName",
    resources: (flow: Flow) => [flow.flowArn],
  }),
);
