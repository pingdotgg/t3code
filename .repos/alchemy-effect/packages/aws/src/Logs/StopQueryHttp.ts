import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { StopQuery } from "./StopQuery.ts";

export const StopQueryHttp = Layer.effect(
  StopQuery,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.StopQuery",
    operation: Logs.stopQuery,
    actions: ["logs:StopQuery"],
    // logs:StopQuery does not support resource-level permissions — an
    // exact log-group-ARN statement never matches (verified via the IAM
    // policy simulator: allowed for StartQuery/GetQueryResults on the same
    // ARN, implicitDeny for StopQuery). Grant on `*`.
    iamResources: "all",
    // Scoped by the query id returned from StartQuery.
    injectLogGroupName: false,
  }),
);
