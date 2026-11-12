import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import { makeIvsRealtimeStageHttpBinding } from "./BindingHttp.ts";
import { ListParticipantReplicas } from "./ListParticipantReplicas.ts";

export const ListParticipantReplicasHttp = Layer.effect(
  ListParticipantReplicas,
  makeIvsRealtimeStageHttpBinding({
    tag: "AWS.IVSRealtime.ListParticipantReplicas",
    operation: ivsrealtime.listParticipantReplicas,
    actions: ["ivs:ListParticipantReplicas"],
    requestKey: "sourceStageArn",
  }),
);
