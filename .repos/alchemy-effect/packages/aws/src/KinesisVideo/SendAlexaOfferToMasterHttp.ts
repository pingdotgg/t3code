import * as kvs from "@distilled.cloud/aws/kinesis-video-signaling";
import * as Layer from "effect/Layer";
import { makeChannelSignalingHttpBinding } from "./BindingHttp.ts";
import { SendAlexaOfferToMaster } from "./SendAlexaOfferToMaster.ts";

export const SendAlexaOfferToMasterHttp = Layer.effect(
  SendAlexaOfferToMaster,
  makeChannelSignalingHttpBinding({
    tag: "AWS.KinesisVideo.SendAlexaOfferToMaster",
    // SendAlexaOfferToMaster is served by the channel's HTTPS signaling
    // endpoint; the offer is addressed to the MASTER peer.
    protocol: "HTTPS",
    role: "MASTER",
    actions: ["kinesisvideo:SendAlexaOfferToMaster"],
    key: "ChannelARN",
    operation: kvs.sendAlexaOfferToMaster,
  }),
);
