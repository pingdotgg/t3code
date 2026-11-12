import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveAccountHttpBinding } from "./BindingHttp.ts";
import { ListChannels } from "./ListChannels.ts";

export const ListChannelsHttp = Layer.effect(
  ListChannels,
  makeMediaLiveAccountHttpBinding({
    tag: "AWS.MediaLive.ListChannels",
    operation: medialive.listChannels,
    actions: ["medialive:ListChannels"],
  }),
);
