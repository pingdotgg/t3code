import * as ivs from "@distilled.cloud/aws/ivs";
import * as Layer from "effect/Layer";
import { makeIvsChannelHttpBinding } from "./BindingHttp.ts";
import { StopStream } from "./StopStream.ts";

export const StopStreamHttp = Layer.effect(
  StopStream,
  makeIvsChannelHttpBinding({
    tag: "AWS.IVS.StopStream",
    operation: ivs.stopStream,
    actions: ["ivs:StopStream"],
  }),
);
