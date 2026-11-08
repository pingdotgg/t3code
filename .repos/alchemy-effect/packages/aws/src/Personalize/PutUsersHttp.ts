import * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import * as Layer from "effect/Layer";
import { makePersonalizeDatasetHttpBinding } from "./BindingHttp.ts";
import { PutUsers } from "./PutUsers.ts";

export const PutUsersHttp = Layer.effect(
  PutUsers,
  makePersonalizeDatasetHttpBinding({
    tag: "AWS.Personalize.PutUsers",
    operation: personalizeevents.putUsers,
    actions: ["personalize:PutUsers"],
  }),
);
