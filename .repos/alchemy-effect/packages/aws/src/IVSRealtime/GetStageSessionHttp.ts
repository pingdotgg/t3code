import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import { makeIvsRealtimeStageHttpBinding } from "./BindingHttp.ts";
import { GetStageSession } from "./GetStageSession.ts";

export const GetStageSessionHttp = Layer.effect(
  GetStageSession,
  makeIvsRealtimeStageHttpBinding({
    tag: "AWS.IVSRealtime.GetStageSession",
    operation: ivsrealtime.getStageSession,
    actions: ["ivs:GetStageSession"],
  }),
);
