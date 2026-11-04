import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { ResetGraph } from "./ResetGraph.ts";

export const ResetGraphHttp = Layer.effect(
  ResetGraph,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.ResetGraph",
    operation: neptunegraph.resetGraph,
    actions: ["neptune-graph:ResetGraph"],
  }),
);
