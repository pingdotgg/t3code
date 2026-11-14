import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { CancelQuery } from "./CancelQuery.ts";

export const CancelQueryHttp = Layer.effect(
  CancelQuery,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.CancelQuery",
    operation: neptunegraph.cancelQuery,
    actions: ["neptune-graph:CancelQuery"],
  }),
);
