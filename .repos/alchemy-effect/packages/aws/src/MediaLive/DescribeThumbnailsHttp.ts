import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveChannelHttpBinding } from "./BindingHttp.ts";
import { DescribeThumbnails } from "./DescribeThumbnails.ts";

export const DescribeThumbnailsHttp = Layer.effect(
  DescribeThumbnails,
  makeMediaLiveChannelHttpBinding({
    tag: "AWS.MediaLive.DescribeThumbnails",
    operation: medialive.describeThumbnails,
    actions: ["medialive:DescribeThumbnails"],
  }),
);
