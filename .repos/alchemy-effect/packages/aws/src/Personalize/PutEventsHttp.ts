import * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import * as Layer from "effect/Layer";
import { makePersonalizeEventTrackerHttpBinding } from "./BindingHttp.ts";
import { PutEvents } from "./PutEvents.ts";

export const PutEventsHttp = Layer.effect(
  PutEvents,
  makePersonalizeEventTrackerHttpBinding({
    tag: "AWS.Personalize.PutEvents",
    operation: personalizeevents.putEvents,
    actions: ["personalize:PutEvents"],
  }),
);
