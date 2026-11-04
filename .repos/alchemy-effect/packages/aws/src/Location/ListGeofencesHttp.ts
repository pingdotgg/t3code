import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";
import { ListGeofences } from "./ListGeofences.ts";

export const ListGeofencesHttp = Layer.effect(
  ListGeofences,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.ListGeofences",
    operation: location.listGeofences,
    actions: ["geo:ListGeofences"],
  }),
);
