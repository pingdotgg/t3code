import * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import * as Layer from "effect/Layer";
import { makeStreamMediaHttpBinding } from "./BindingHttp.ts";
import { GetClip } from "./GetClip.ts";

export const GetClipHttp = Layer.effect(
  GetClip,
  makeStreamMediaHttpBinding({
    tag: "AWS.KinesisVideo.GetClip",
    apiName: "GET_CLIP",
    actions: ["kinesisvideo:GetClip"],
    operation: kvam.getClip,
  }),
);
