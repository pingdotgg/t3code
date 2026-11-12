import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { GetIncidentRecord } from "./GetIncidentRecord.ts";

export const GetIncidentRecordHttp = Layer.effect(
  GetIncidentRecord,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.GetIncidentRecord",
    operation: incidents.getIncidentRecord,
    actions: ["ssm-incidents:GetIncidentRecord"],
  }),
);
