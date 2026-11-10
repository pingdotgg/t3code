import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveChannelHttpBinding } from "./BindingHttp.ts";
import { DescribeChannel } from "./DescribeChannel.ts";

export const DescribeChannelHttp = Layer.effect(
  DescribeChannel,
  makeMediaLiveChannelHttpBinding({
    tag: "AWS.MediaLive.DescribeChannel",
    operation: medialive.describeChannel,
    actions: ["medialive:DescribeChannel"],
  }),
);
