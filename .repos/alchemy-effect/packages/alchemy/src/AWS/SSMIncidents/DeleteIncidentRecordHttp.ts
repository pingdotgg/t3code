import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteIncidentRecord } from "./DeleteIncidentRecord.ts";

export const DeleteIncidentRecordHttp = Layer.effect(
  DeleteIncidentRecord,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.DeleteIncidentRecord",
    operation: incidents.deleteIncidentRecord,
    actions: ["ssm-incidents:DeleteIncidentRecord"],
  }),
);
