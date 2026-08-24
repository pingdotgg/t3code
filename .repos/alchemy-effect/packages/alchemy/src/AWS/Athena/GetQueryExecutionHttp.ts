import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeWorkGroupScopedHttpBinding } from "./BindingHttp.ts";
import { GetQueryExecution } from "./GetQueryExecution.ts";

export const GetQueryExecutionHttp = Layer.effect(
  GetQueryExecution,
  makeWorkGroupScopedHttpBinding({
    tag: "AWS.Athena.GetQueryExecution",
    operation: athena.getQueryExecution,
    actions: ["athena:GetQueryExecution"],
  }),
);
