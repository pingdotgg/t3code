import * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import * as Layer from "effect/Layer";
import { makeStreamMediaHttpBinding } from "./BindingHttp.ts";
import { GetMediaForFragmentList } from "./GetMediaForFragmentList.ts";

export const GetMediaForFragmentListHttp = Layer.effect(
  GetMediaForFragmentList,
  makeStreamMediaHttpBinding({
    tag: "AWS.KinesisVideo.GetMediaForFragmentList",
    apiName: "GET_MEDIA_FOR_FRAGMENT_LIST",
    actions: ["kinesisvideo:GetMediaForFragmentList"],
    operation: kvam.getMediaForFragmentList,
  }),
);
