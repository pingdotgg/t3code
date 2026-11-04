import * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import * as Layer from "effect/Layer";
import { makePersonalizeDatasetHttpBinding } from "./BindingHttp.ts";
import { PutItems } from "./PutItems.ts";

export const PutItemsHttp = Layer.effect(
  PutItems,
  makePersonalizeDatasetHttpBinding({
    tag: "AWS.Personalize.PutItems",
    operation: personalizeevents.putItems,
    actions: ["personalize:PutItems"],
  }),
);
