import * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import * as Layer from "effect/Layer";
import { makeMwaaServerlessHttpBinding } from "./BindingHttp.ts";
import { ListWorkflowRuns } from "./ListWorkflowRuns.ts";

export const ListWorkflowRunsHttp = Layer.effect(
  ListWorkflowRuns,
  makeMwaaServerlessHttpBinding({
    tag: "AWS.MWAAServerless.ListWorkflowRuns",
    operation: mwaa.listWorkflowRuns,
    actions: ["airflow-serverless:ListWorkflowRuns"],
  }),
);
