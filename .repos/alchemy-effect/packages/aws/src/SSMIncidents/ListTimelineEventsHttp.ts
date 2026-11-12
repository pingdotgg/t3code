import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { ListTimelineEvents } from "./ListTimelineEvents.ts";

export const ListTimelineEventsHttp = Layer.effect(
  ListTimelineEvents,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.ListTimelineEvents",
    operation: incidents.listTimelineEvents,
    actions: ["ssm-incidents:ListTimelineEvents"],
  }),
);
