import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { BatchGetIncidentFindings } from "./BatchGetIncidentFindings.ts";

export const BatchGetIncidentFindingsHttp = Layer.effect(
  BatchGetIncidentFindings,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.BatchGetIncidentFindings",
    operation: incidents.batchGetIncidentFindings,
    actions: ["ssm-incidents:BatchGetIncidentFindings"],
  }),
);
