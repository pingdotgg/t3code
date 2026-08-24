import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { StopGraph } from "./StopGraph.ts";

export const StopGraphHttp = Layer.effect(
  StopGraph,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.StopGraph",
    operation: neptunegraph.stopGraph,
    actions: ["neptune-graph:StopGraph"],
  }),
);
