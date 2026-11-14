import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { GetQueryResults } from "./GetQueryResults.ts";

export const GetQueryResultsHttp = Layer.effect(
  GetQueryResults,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.GetQueryResults",
    operation: Logs.getQueryResults,
    actions: ["logs:GetQueryResults"],
    // Scoped by the query id returned from StartQuery.
    injectLogGroupName: false,
  }),
);
