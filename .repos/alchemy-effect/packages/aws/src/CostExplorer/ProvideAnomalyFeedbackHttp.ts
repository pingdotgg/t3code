import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { ProvideAnomalyFeedback } from "./ProvideAnomalyFeedback.ts";

export const ProvideAnomalyFeedbackHttp = Layer.effect(
  ProvideAnomalyFeedback,
  makeCostExplorerHttpBinding({
    capability: "ProvideAnomalyFeedback",
    iamActions: ["ce:ProvideAnomalyFeedback"],
    operation: ce.provideAnomalyFeedback,
  }),
);
