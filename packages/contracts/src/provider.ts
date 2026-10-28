import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ChatAttachment,
} from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  /** Internal recovery: permits empty turns only for adapters supporting promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

/** SDP payloads are a few KiB; the bound keeps a hostile client from pinning memory. */
const VOICE_SDP_MAX_CHARS = 64 * 1024;

export const ProviderVoiceSessionInput = Schema.Struct({
  threadId: ThreadId,
  /** WebRTC offer from a peer connection with one mic track and an `oai-events` data channel. */
  // Not trimmed: SDP lines are CRLF-terminated, including the last one.
  offerSdp: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(VOICE_SDP_MAX_CHARS)),
});
export type ProviderVoiceSessionInput = typeof ProviderVoiceSessionInput.Type;

export const ProviderVoiceTranscriptRole = Schema.Literals(["user", "assistant"]);
export type ProviderVoiceTranscriptRole = typeof ProviderVoiceTranscriptRole.Type;

/**
 * Events for one voice conversation. Audio flows peer-to-peer between the
 * client and the provider's realtime backend; only signaling and captions
 * cross this stream. Unsubscribing stops the conversation.
 */
export const ProviderVoiceSessionEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("answer"), sdp: Schema.String }),
  Schema.Struct({ type: Schema.Literal("started") }),
  Schema.Struct({
    type: Schema.Literal("transcript.delta"),
    role: ProviderVoiceTranscriptRole,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("transcript.done"),
    role: ProviderVoiceTranscriptRole,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    reason: Schema.optional(Schema.String),
  }),
]);
export type ProviderVoiceSessionEvent = typeof ProviderVoiceSessionEvent.Type;

export class ProviderVoiceSessionError extends Schema.TaggedError<ProviderVoiceSessionError>()(
  "ProviderVoiceSessionError",
  {
    threadId: ThreadId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
