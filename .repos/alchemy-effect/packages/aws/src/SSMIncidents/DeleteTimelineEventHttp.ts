import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteTimelineEvent } from "./DeleteTimelineEvent.ts";

export const DeleteTimelineEventHttp = Layer.effect(
  DeleteTimelineEvent,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.DeleteTimelineEvent",
    operation: incidents.deleteTimelineEvent,
    actions: ["ssm-incidents:DeleteTimelineEvent"],
  }),
);
