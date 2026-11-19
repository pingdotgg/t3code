import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import * as Layer from "effect/Layer";
import { makeMediaPackageV2ChannelHttpBinding } from "./BindingHttp.ts";
import { ResetChannelState } from "./ResetChannelState.ts";

export const ResetChannelStateHttp = Layer.effect(
  ResetChannelState,
  makeMediaPackageV2ChannelHttpBinding({
    tag: "AWS.MediaPackageV2.ResetChannelState",
    operation: mediapackagev2.resetChannelState,
    actions: ["mediapackagev2:ResetChannelState"],
  }),
);
