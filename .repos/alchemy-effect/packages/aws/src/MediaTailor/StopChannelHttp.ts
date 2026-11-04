import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";
import { StopChannel } from "./StopChannel.ts";

export const StopChannelHttp = Layer.effect(
  StopChannel,
  makeMediaTailorHttpBinding({
    capability: "StopChannel",
    iamActions: ["mediatailor:StopChannel"],
    operation: mediatailor.stopChannel,
  }),
);
