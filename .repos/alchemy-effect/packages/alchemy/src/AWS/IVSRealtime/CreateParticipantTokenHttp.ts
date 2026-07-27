import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import { toWireMinutes } from "../../Util/Duration.ts";
import { makeIvsRealtimeStageHttpBinding } from "./BindingHttp.ts";
import {
  CreateParticipantToken,
  type CreateParticipantTokenRequest,
} from "./CreateParticipantToken.ts";

export const CreateParticipantTokenHttp = Layer.effect(
  CreateParticipantToken,
  makeIvsRealtimeStageHttpBinding({
    tag: "AWS.IVSRealtime.CreateParticipantToken",
    operation: ivsrealtime.createParticipantToken,
    actions: ["ivs:CreateParticipantToken"],
    prepare: ({ duration, ...request }: CreateParticipantTokenRequest) => ({
      ...request,
      duration: toWireMinutes(duration),
    }),
  }),
);
