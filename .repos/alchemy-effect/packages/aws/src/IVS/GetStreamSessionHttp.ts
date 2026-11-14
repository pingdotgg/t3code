import * as ivs from "@distilled.cloud/aws/ivs";
import * as Layer from "effect/Layer";
import { makeIvsChannelHttpBinding } from "./BindingHttp.ts";
import { GetStreamSession } from "./GetStreamSession.ts";

export const GetStreamSessionHttp = Layer.effect(
  GetStreamSession,
  makeIvsChannelHttpBinding({
    tag: "AWS.IVS.GetStreamSession",
    operation: ivs.getStreamSession,
    actions: ["ivs:GetStreamSession"],
  }),
);
