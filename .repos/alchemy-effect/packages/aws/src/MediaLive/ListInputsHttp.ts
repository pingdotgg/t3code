import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveAccountHttpBinding } from "./BindingHttp.ts";
import { ListInputs } from "./ListInputs.ts";

export const ListInputsHttp = Layer.effect(
  ListInputs,
  makeMediaLiveAccountHttpBinding({
    tag: "AWS.MediaLive.ListInputs",
    operation: medialive.listInputs,
    actions: ["medialive:ListInputs"],
  }),
);
