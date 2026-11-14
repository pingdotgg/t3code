import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import { makeIvsRealtimeReplicationHttpBinding } from "./BindingHttp.ts";
import { StopParticipantReplication } from "./StopParticipantReplication.ts";

export const StopParticipantReplicationHttp = Layer.effect(
  StopParticipantReplication,
  makeIvsRealtimeReplicationHttpBinding({
    tag: "AWS.IVSRealtime.StopParticipantReplication",
    operation: ivsrealtime.stopParticipantReplication,
    actions: ["ivs:StopParticipantReplication"],
  }),
);
