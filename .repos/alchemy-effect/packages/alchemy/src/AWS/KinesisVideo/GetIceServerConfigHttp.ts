import * as kvs from "@distilled.cloud/aws/kinesis-video-signaling";
import * as Layer from "effect/Layer";
import { makeChannelSignalingHttpBinding } from "./BindingHttp.ts";
import { GetIceServerConfig } from "./GetIceServerConfig.ts";

export const GetIceServerConfigHttp = Layer.effect(
  GetIceServerConfig,
  makeChannelSignalingHttpBinding({
    tag: "AWS.KinesisVideo.GetIceServerConfig",
    // GetIceServerConfig is served by the channel's HTTPS signaling
    // endpoint; the MASTER role endpoint answers for either peer role.
    protocol: "HTTPS",
    role: "MASTER",
    actions: ["kinesisvideo:GetIceServerConfig"],
    key: "ChannelARN",
    operation: kvs.getIceServerConfig,
  }),
);
