import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateIncidentRecord } from "./UpdateIncidentRecord.ts";

export const UpdateIncidentRecordHttp = Layer.effect(
  UpdateIncidentRecord,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.UpdateIncidentRecord",
    operation: incidents.updateIncidentRecord,
    actions: ["ssm-incidents:UpdateIncidentRecord"],
  }),
);
