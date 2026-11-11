import * as appflow from "@distilled.cloud/aws/appflow";
import * as Layer from "effect/Layer";
import { makeAppFlowHttpBinding } from "./BindingHttp.ts";
import type { Flow } from "./Flow.ts";
import { StartFlow } from "./StartFlow.ts";

export const StartFlowHttp = Layer.effect(
  StartFlow,
  makeAppFlowHttpBinding({
    action: "StartFlow",
    operation: appflow.startFlow,
    identifier: (flow: Flow) => flow.flowName,
    requestKey: "flowName",
    resources: (flow: Flow) => [flow.flowArn],
  }),
);
