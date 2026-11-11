import * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import * as Layer from "effect/Layer";
import { makePersonalizeDatasetHttpBinding } from "./BindingHttp.ts";
import { PutActions } from "./PutActions.ts";

export const PutActionsHttp = Layer.effect(
  PutActions,
  makePersonalizeDatasetHttpBinding({
    tag: "AWS.Personalize.PutActions",
    operation: personalizeevents.putActions,
    actions: ["personalize:PutActions"],
  }),
);
