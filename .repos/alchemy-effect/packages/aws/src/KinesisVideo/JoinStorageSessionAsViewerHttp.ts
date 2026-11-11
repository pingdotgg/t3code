import * as kvws from "@distilled.cloud/aws/kinesis-video-webrtc-storage";
import * as Layer from "effect/Layer";
import { makeChannelSignalingHttpBinding } from "./BindingHttp.ts";
import { JoinStorageSessionAsViewer } from "./JoinStorageSessionAsViewer.ts";

export const JoinStorageSessionAsViewerHttp = Layer.effect(
  JoinStorageSessionAsViewer,
  makeChannelSignalingHttpBinding({
    tag: "AWS.KinesisVideo.JoinStorageSessionAsViewer",
    // served by the channel's WEBRTC storage endpoint (only available once
    // media storage is configured for the channel)
    protocol: "WEBRTC",
    role: "VIEWER",
    actions: ["kinesisvideo:JoinStorageSessionAsViewer"],
    key: "channelArn",
    operation: kvws.joinStorageSessionAsViewer,
  }),
);
