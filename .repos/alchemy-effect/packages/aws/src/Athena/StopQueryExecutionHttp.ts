import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeWorkGroupScopedHttpBinding } from "./BindingHttp.ts";
import { StopQueryExecution } from "./StopQueryExecution.ts";

export const StopQueryExecutionHttp = Layer.effect(
  StopQueryExecution,
  makeWorkGroupScopedHttpBinding({
    tag: "AWS.Athena.StopQueryExecution",
    operation: athena.stopQueryExecution,
    actions: ["athena:StopQueryExecution"],
  }),
);
