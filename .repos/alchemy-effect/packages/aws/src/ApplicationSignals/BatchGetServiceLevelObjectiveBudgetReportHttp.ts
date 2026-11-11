import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { BatchGetServiceLevelObjectiveBudgetReport } from "./BatchGetServiceLevelObjectiveBudgetReport.ts";
import { makeSloBatchHttpBinding } from "./BindingHttp.ts";

export const BatchGetServiceLevelObjectiveBudgetReportHttp = Layer.effect(
  BatchGetServiceLevelObjectiveBudgetReport,
  makeSloBatchHttpBinding({
    tag: "AWS.ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReport",
    operation: appsignals.batchGetServiceLevelObjectiveBudgetReport,
    actions: ["application-signals:BatchGetServiceLevelObjectiveBudgetReport"],
    // Budget reports evaluate the SLI with the CALLER's credentials —
    // verified live: without cloudwatch:GetMetricData the operation fails
    // with AccessDeniedException (empty message).
    accountActions: ["cloudwatch:GetMetricData"],
  }),
);
