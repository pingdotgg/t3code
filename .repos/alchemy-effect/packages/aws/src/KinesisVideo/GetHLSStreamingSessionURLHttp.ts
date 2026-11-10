import * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import * as Layer from "effect/Layer";
import { makeStreamMediaHttpBinding } from "./BindingHttp.ts";
import { GetHLSStreamingSessionURL } from "./GetHLSStreamingSessionURL.ts";

export const GetHLSStreamingSessionURLHttp = Layer.effect(
  GetHLSStreamingSessionURL,
  makeStreamMediaHttpBinding({
    tag: "AWS.KinesisVideo.GetHLSStreamingSessionURL",
    apiName: "GET_HLS_STREAMING_SESSION_URL",
    actions: ["kinesisvideo:GetHLSStreamingSessionURL"],
    operation: kvam.getHLSStreamingSessionURL,
  }),
);
