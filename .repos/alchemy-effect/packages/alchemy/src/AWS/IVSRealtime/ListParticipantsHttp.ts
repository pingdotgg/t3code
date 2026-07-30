import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import { makeIvsRealtimeStageHttpBinding } from "./BindingHttp.ts";
import { ListParticipants } from "./ListParticipants.ts";

export const ListParticipantsHttp = Layer.effect(
  ListParticipants,
  makeIvsRealtimeStageHttpBinding({
    tag: "AWS.IVSRealtime.ListParticipants",
    operation: ivsrealtime.listParticipants,
    actions: ["ivs:ListParticipants"],
  }),
);
