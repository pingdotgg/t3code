import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { BatchGetIncidentFindings } from "./BatchGetIncidentFindings.ts";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";

export const BatchGetIncidentFindingsHttp = Layer.effect(
  BatchGetIncidentFindings,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.BatchGetIncidentFindings",
    operation: incidents.batchGetIncidentFindings,
    actions: ["ssm-incidents:BatchGetIncidentFindings"],
  }),
);
