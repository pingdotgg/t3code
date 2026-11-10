import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { ListIncidentRecords } from "./ListIncidentRecords.ts";

export const ListIncidentRecordsHttp = Layer.effect(
  ListIncidentRecords,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.ListIncidentRecords",
    operation: incidents.listIncidentRecords,
    actions: ["ssm-incidents:ListIncidentRecords"],
  }),
);
