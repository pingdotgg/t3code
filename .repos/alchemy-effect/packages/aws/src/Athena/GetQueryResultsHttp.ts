import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeWorkGroupScopedHttpBinding } from "./BindingHttp.ts";
import { GetQueryResults } from "./GetQueryResults.ts";

export const GetQueryResultsHttp = Layer.effect(
  GetQueryResults,
  makeWorkGroupScopedHttpBinding({
    tag: "AWS.Athena.GetQueryResults",
    operation: athena.getQueryResults,
    actions: ["athena:GetQueryResults"],
  }),
);
