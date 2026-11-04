import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import { makeIvsRealtimeStageHttpBinding } from "./BindingHttp.ts";
import { DisconnectParticipant } from "./DisconnectParticipant.ts";

export const DisconnectParticipantHttp = Layer.effect(
  DisconnectParticipant,
  makeIvsRealtimeStageHttpBinding({
    tag: "AWS.IVSRealtime.DisconnectParticipant",
    operation: ivsrealtime.disconnectParticipant,
    actions: ["ivs:DisconnectParticipant"],
  }),
);
