import * as ivs from "@distilled.cloud/aws/ivs";
import * as Layer from "effect/Layer";
import { makeIvsChannelHttpBinding } from "./BindingHttp.ts";
import { GetStream } from "./GetStream.ts";

export const GetStreamHttp = Layer.effect(
  GetStream,
  makeIvsChannelHttpBinding({
    tag: "AWS.IVS.GetStream",
    operation: ivs.getStream,
    actions: ["ivs:GetStream"],
  }),
);
