import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { StartGraph } from "./StartGraph.ts";

export const StartGraphHttp = Layer.effect(
  StartGraph,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.StartGraph",
    operation: neptunegraph.startGraph,
    actions: ["neptune-graph:StartGraph"],
  }),
);
