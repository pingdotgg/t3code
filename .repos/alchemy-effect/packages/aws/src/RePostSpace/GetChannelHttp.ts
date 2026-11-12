import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";
import { GetChannel } from "./GetChannel.ts";

export const GetChannelHttp = Layer.effect(
  GetChannel,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.GetChannel",
    operation: repostspace.getChannel,
    actions: ["repostspace:GetChannel"],
  }),
);
