import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { GetMedia } from "./GetMedia.ts";

export const GetMediaHttp = Layer.effect(
  GetMedia,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.GetMedia",
    operation: qbusiness.getMedia,
    actions: ["qbusiness:GetMedia"],
  }),
);
