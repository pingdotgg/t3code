import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { GetTimelineEvent } from "./GetTimelineEvent.ts";

export const GetTimelineEventHttp = Layer.effect(
  GetTimelineEvent,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.GetTimelineEvent",
    operation: incidents.getTimelineEvent,
    actions: ["ssm-incidents:GetTimelineEvent"],
  }),
);
