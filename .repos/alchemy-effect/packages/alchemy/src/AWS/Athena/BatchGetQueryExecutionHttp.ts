import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeWorkGroupScopedHttpBinding } from "./BindingHttp.ts";
import { BatchGetQueryExecution } from "./BatchGetQueryExecution.ts";

export const BatchGetQueryExecutionHttp = Layer.effect(
  BatchGetQueryExecution,
  makeWorkGroupScopedHttpBinding({
    tag: "AWS.Athena.BatchGetQueryExecution",
    operation: athena.batchGetQueryExecution,
    actions: ["athena:BatchGetQueryExecution"],
  }),
);
