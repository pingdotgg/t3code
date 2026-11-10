import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { CreateTimelineEvent } from "./CreateTimelineEvent.ts";

export const CreateTimelineEventHttp = Layer.effect(
  CreateTimelineEvent,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.CreateTimelineEvent",
    operation: incidents.createTimelineEvent,
    actions: ["ssm-incidents:CreateTimelineEvent"],
  }),
);
