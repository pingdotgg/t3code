import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { GetQuery } from "./GetQuery.ts";

export const GetQueryHttp = Layer.effect(
  GetQuery,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.GetQuery",
    operation: neptunegraph.getQuery,
    actions: ["neptune-graph:GetQueryStatus"],
  }),
);
