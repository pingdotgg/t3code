import * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import * as Layer from "effect/Layer";
import { makeMwaaServerlessHttpBinding } from "./BindingHttp.ts";
import { StopWorkflowRun } from "./StopWorkflowRun.ts";

export const StopWorkflowRunHttp = Layer.effect(
  StopWorkflowRun,
  makeMwaaServerlessHttpBinding({
    tag: "AWS.MWAAServerless.StopWorkflowRun",
    operation: mwaa.stopWorkflowRun,
    actions: ["airflow-serverless:StopWorkflowRun"],
  }),
);
