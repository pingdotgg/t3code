import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveChannelHttpBinding } from "./BindingHttp.ts";
import { RestartChannelPipelines } from "./RestartChannelPipelines.ts";

export const RestartChannelPipelinesHttp = Layer.effect(
  RestartChannelPipelines,
  makeMediaLiveChannelHttpBinding({
    tag: "AWS.MediaLive.RestartChannelPipelines",
    operation: medialive.restartChannelPipelines,
    actions: ["medialive:RestartChannelPipelines"],
  }),
);
