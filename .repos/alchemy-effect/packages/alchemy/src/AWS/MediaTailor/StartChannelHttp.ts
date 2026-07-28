import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";
import { StartChannel } from "./StartChannel.ts";

export const StartChannelHttp = Layer.effect(
  StartChannel,
  makeMediaTailorHttpBinding({
    capability: "StartChannel",
    iamActions: ["mediatailor:StartChannel"],
    operation: mediatailor.startChannel,
  }),
);
