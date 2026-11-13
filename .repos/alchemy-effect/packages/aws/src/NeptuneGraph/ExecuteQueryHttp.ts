import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { ExecuteQuery } from "./ExecuteQuery.ts";

/**
 * HTTP implementation of the {@link ExecuteQuery} binding — signs
 * `neptune-graph:ExecuteQuery` data-plane requests against the graph's HTTPS
 * endpoint and, at deploy time, grants the query IAM actions
 * (`ReadDataViaQuery`, `WriteDataViaQuery`, `DeleteDataViaQuery`) on the
 * bound graph to the host function.
 */
export const ExecuteQueryHttp = Layer.effect(
  ExecuteQuery,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.ExecuteQuery",
    operation: neptunegraph.executeQuery,
    actions: [
      "neptune-graph:ReadDataViaQuery",
      "neptune-graph:WriteDataViaQuery",
      "neptune-graph:DeleteDataViaQuery",
    ],
  }),
);
