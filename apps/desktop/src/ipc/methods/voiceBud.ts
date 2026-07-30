import {
  VoiceBudAcknowledgeDeliveryInput,
  VoiceBudBindRecordingInput,
  VoiceBudOperationResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeIpcMethod } from "../DesktopIpc.ts";
import {
  VOICE_BUD_ACKNOWLEDGE_DELIVERY_CHANNEL,
  VOICE_BUD_BIND_RECORDING_CHANNEL,
} from "../channels.ts";
import * as VoiceBudBridge from "../../voicebud/VoiceBudBridge.ts";

export const bindVoiceBudRecording = makeIpcMethod({
  channel: VOICE_BUD_BIND_RECORDING_CHANNEL,
  payload: VoiceBudBindRecordingInput,
  result: VoiceBudOperationResult,
  handler: (input) =>
    VoiceBudBridge.VoiceBudBridge.pipe(
      Effect.flatMap((bridge) => bridge.bindRecording(input)),
      Effect.map((accepted) => ({ accepted })),
    ),
});

export const acknowledgeVoiceBudDelivery = makeIpcMethod({
  channel: VOICE_BUD_ACKNOWLEDGE_DELIVERY_CHANNEL,
  payload: VoiceBudAcknowledgeDeliveryInput,
  result: VoiceBudOperationResult,
  handler: (input) =>
    VoiceBudBridge.VoiceBudBridge.pipe(
      Effect.flatMap((bridge) => bridge.acknowledgeDelivery(input)),
      Effect.map((accepted) => ({ accepted })),
    ),
});
