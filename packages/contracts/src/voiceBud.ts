import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VOICE_BUD_PROTOCOL_VERSION = 1 as const;
export const VOICE_BUD_MAX_TRANSCRIPT_CHARS = 32_768;

const VoiceBudOpaqueId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
);

export const VoiceBudRecordingId = VoiceBudOpaqueId.pipe(Schema.brand("VoiceBudRecordingId"));
export type VoiceBudRecordingId = typeof VoiceBudRecordingId.Type;

export const VoiceBudRequestId = VoiceBudOpaqueId.pipe(Schema.brand("VoiceBudRequestId"));
export type VoiceBudRequestId = typeof VoiceBudRequestId.Type;

export const VoiceBudNonce = VoiceBudOpaqueId.pipe(Schema.brand("VoiceBudNonce"));
export type VoiceBudNonce = typeof VoiceBudNonce.Type;

export const VoiceBudDraftId = VoiceBudOpaqueId.pipe(Schema.brand("VoiceBudDraftId"));
export type VoiceBudDraftId = typeof VoiceBudDraftId.Type;

export const VoiceBudDraftTarget = Schema.Union([
  Schema.TaggedStruct("Thread", {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  }),
  Schema.TaggedStruct("Draft", {
    draftId: VoiceBudDraftId,
  }),
]);
export type VoiceBudDraftTarget = typeof VoiceBudDraftTarget.Type;

const VoiceBudAuthenticatedEnvelope = {
  version: Schema.Literal(VOICE_BUD_PROTOCOL_VERSION),
  requestId: VoiceBudRequestId,
  recordingId: VoiceBudRecordingId,
  nonce: VoiceBudNonce,
  sentAt: Schema.Int,
  auth: Schema.String.check(Schema.isMinLength(43), Schema.isMaxLength(128)),
};

export const VoiceBudRecordingStartedRequest = Schema.Struct({
  ...VoiceBudAuthenticatedEnvelope,
  type: Schema.Literal("recording.started"),
});
export type VoiceBudRecordingStartedRequest = typeof VoiceBudRecordingStartedRequest.Type;

export const VoiceBudTranscriptionCompletedRequest = Schema.Struct({
  ...VoiceBudAuthenticatedEnvelope,
  type: Schema.Literal("transcription.completed"),
  transcript: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(VOICE_BUD_MAX_TRANSCRIPT_CHARS),
  ),
});
export type VoiceBudTranscriptionCompletedRequest =
  typeof VoiceBudTranscriptionCompletedRequest.Type;

export const VoiceBudExternalRequest = Schema.Union([
  VoiceBudRecordingStartedRequest,
  VoiceBudTranscriptionCompletedRequest,
]);
export type VoiceBudExternalRequest = typeof VoiceBudExternalRequest.Type;

export const VoiceBudResponseCode = Schema.Literals([
  "accepted",
  "authentication_failed",
  "expired",
  "malformed",
  "oversized",
  "rate_limited",
  "replay",
  "duplicate_recording",
  "unknown_recording",
  "renderer_unavailable",
  "delivery_failed",
  "delivery_ambiguous",
]);
export type VoiceBudResponseCode = typeof VoiceBudResponseCode.Type;

export const VoiceBudExternalResponse = Schema.Struct({
  version: Schema.Literal(VOICE_BUD_PROTOCOL_VERSION),
  requestId: Schema.NullOr(VoiceBudRequestId),
  accepted: Schema.Boolean,
  code: VoiceBudResponseCode,
});
export type VoiceBudExternalResponse = typeof VoiceBudExternalResponse.Type;

export const VoiceBudRecordingStartedEvent = Schema.Struct({
  requestId: VoiceBudRequestId,
  recordingId: VoiceBudRecordingId,
});
export type VoiceBudRecordingStartedEvent = typeof VoiceBudRecordingStartedEvent.Type;

export const VoiceBudBindRecordingInput = Schema.Struct({
  requestId: VoiceBudRequestId,
  recordingId: VoiceBudRecordingId,
  target: VoiceBudDraftTarget,
});
export type VoiceBudBindRecordingInput = typeof VoiceBudBindRecordingInput.Type;

export const VoiceBudTranscriptionEvent = Schema.Struct({
  deliveryId: VoiceBudRequestId,
  recordingId: VoiceBudRecordingId,
  target: VoiceBudDraftTarget,
  transcript: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(VOICE_BUD_MAX_TRANSCRIPT_CHARS),
  ),
});
export type VoiceBudTranscriptionEvent = typeof VoiceBudTranscriptionEvent.Type;

export const VoiceBudAcknowledgeDeliveryInput = Schema.Struct({
  deliveryId: VoiceBudRequestId,
  applied: Schema.Boolean,
});
export type VoiceBudAcknowledgeDeliveryInput = typeof VoiceBudAcknowledgeDeliveryInput.Type;

export const VoiceBudOperationResult = Schema.Struct({
  accepted: Schema.Boolean,
});
export type VoiceBudOperationResult = typeof VoiceBudOperationResult.Type;

export interface DesktopVoiceBudBridge {
  bindRecording: (input: VoiceBudBindRecordingInput) => Promise<VoiceBudOperationResult>;
  acknowledgeDelivery: (
    input: VoiceBudAcknowledgeDeliveryInput,
  ) => Promise<VoiceBudOperationResult>;
  onRecordingStarted: (listener: (event: VoiceBudRecordingStartedEvent) => void) => () => void;
  onTranscription: (listener: (event: VoiceBudTranscriptionEvent) => void) => () => void;
}
