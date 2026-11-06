import * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import * as Layer from "effect/Layer";
import { makePersonalizeEventTrackerHttpBinding } from "./BindingHttp.ts";
import { PutActionInteractions } from "./PutActionInteractions.ts";

export const PutActionInteractionsHttp = Layer.effect(
  PutActionInteractions,
  makePersonalizeEventTrackerHttpBinding({
    tag: "AWS.Personalize.PutActionInteractions",
    operation: personalizeevents.putActionInteractions,
    actions: ["personalize:PutActionInteractions"],
  }),
);
