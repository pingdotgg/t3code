import * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import * as Layer from "effect/Layer";
import { makeMwaaServerlessHttpBinding } from "./BindingHttp.ts";
import { ListWorkflowVersions } from "./ListWorkflowVersions.ts";

export const ListWorkflowVersionsHttp = Layer.effect(
  ListWorkflowVersions,
  makeMwaaServerlessHttpBinding({
    tag: "AWS.MWAAServerless.ListWorkflowVersions",
    operation: mwaa.listWorkflowVersions,
    actions: ["airflow-serverless:ListWorkflowVersions"],
  }),
);
