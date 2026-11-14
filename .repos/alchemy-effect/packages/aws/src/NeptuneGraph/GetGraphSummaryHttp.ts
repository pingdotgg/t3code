import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { GetGraphSummary } from "./GetGraphSummary.ts";

export const GetGraphSummaryHttp = Layer.effect(
  GetGraphSummary,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.GetGraphSummary",
    operation: neptunegraph.getGraphSummary,
    actions: ["neptune-graph:GetGraphSummary"],
  }),
);
