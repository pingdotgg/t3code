import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import { makeIvsRealtimeStageHttpBinding } from "./BindingHttp.ts";
import { ListParticipantEvents } from "./ListParticipantEvents.ts";

export const ListParticipantEventsHttp = Layer.effect(
  ListParticipantEvents,
  makeIvsRealtimeStageHttpBinding({
    tag: "AWS.IVSRealtime.ListParticipantEvents",
    operation: ivsrealtime.listParticipantEvents,
    actions: ["ivs:ListParticipantEvents"],
  }),
);
