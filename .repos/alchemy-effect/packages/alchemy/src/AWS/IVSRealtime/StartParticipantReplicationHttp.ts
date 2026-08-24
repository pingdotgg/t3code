import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toWireSeconds } from "../../Util/Duration.ts";
import { makeIvsRealtimeReplicationHttpBinding } from "./BindingHttp.ts";
import {
  StartParticipantReplication,
  type StartParticipantReplicationRequest,
} from "./StartParticipantReplication.ts";
import type { Stage } from "./Stage.ts";

export const StartParticipantReplicationHttp = Layer.effect(
  StartParticipantReplication,
  Effect.gen(function* () {
    const make = yield* makeIvsRealtimeReplicationHttpBinding({
      tag: "AWS.IVSRealtime.StartParticipantReplication",
      operation: ivsrealtime.startParticipantReplication,
      actions: ["ivs:StartParticipantReplication"],
    });
    return Effect.fn(function* (sourceStage: Stage, destinationStage: Stage) {
      const startReplication = yield* make(sourceStage, destinationStage);
      return ({
        reconnectWindow,
        ...request
      }: StartParticipantReplicationRequest) =>
        startReplication({
          ...request,
          reconnectWindowSeconds: toWireSeconds(reconnectWindow),
        });
    });
  }),
);
