/**
 * Aether workspace WS agent-channel wire events — parse-at-boundary shapes
 * for the live event stream the AetherDriver subscribes to.
 *
 * Wire source (aether repo, read-only reference):
 * `packages/workspace-protocol/src/messages.ts` — the 13-kind agent task
 * event union (3 tool kinds + 10 non-tool kinds), envelope
 * `{channel:"agent", type:"task_event", taskId, kind, createdAt?}`.
 *
 * The SERVER emits `z.strictObject` shapes, but this client parses LOOSELY
 * (plain `Schema.Struct`, open string enums): a newer Aether server adding a
 * field or an event kind must never crash the driver's stream. The contract
 * here (spec §3.11 + build item 5) is:
 *   - additive fields on known kinds: tolerated by construction (loose structs)
 *   - unknown event kinds: an explicit `unknown-kind` carrier — the caller
 *     logs once per kind and drops the frame
 *   - a KNOWN kind whose payload no longer parses: an explicit `malformed`
 *     carrier — the caller warns loudly and drops the frame; the REST delta
 *     reconciliation on the next (re)connect is the durable backstop
 *   - frames for other channels: an `ignored` carrier (never an error — the
 *     socket multiplexes channels by design)
 * Parsing never fails the stream and never kills the socket.
 *
 * @module provider/Layers/aether/wireEvents
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Payload schemas (loose twins of the strict wire schemas)
// ---------------------------------------------------------------------------

/**
 * Tool display: `label` plus the display-block list. Blocks stay opaque
 * (`unknown`) at this boundary — the event mapper reads the two block types
 * it consumes (`terminal`, `todo_list`) defensively, so a new block type is
 * additive instead of fatal.
 */
const AetherWsToolDisplay = Schema.Struct({
  label: Schema.String,
  blocks: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type AetherWsToolDisplay = typeof AetherWsToolDisplay.Type;

const AetherWsToolPayload = Schema.Struct({
  name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  display: AetherWsToolDisplay,
  // Open server enums (tool status, canonical item type) decode as strings.
  status: Schema.String,
  itemType: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type AetherWsToolPayload = typeof AetherWsToolPayload.Type;

const envelopeFields = {
  taskId: Schema.String,
  createdAt: Schema.optional(Schema.String),
} as const;

const messageFields = {
  ...envelopeFields,
  messageId: Schema.String,
  turnId: Schema.optional(Schema.String),
} as const;

const AetherWsToolCallEvent = Schema.Struct({
  ...envelopeFields,
  kind: Schema.Literals(["tool_call.started", "tool_call.completed", "tool_call.failed"]),
  toolCallId: Schema.String,
  turnId: Schema.optional(Schema.String),
  payload: AetherWsToolPayload,
});
export type AetherWsToolCallEvent = typeof AetherWsToolCallEvent.Type;

const AetherWsAssistantDeltaEvent = Schema.Struct({
  ...messageFields,
  kind: Schema.Literal("assistant_message.delta"),
  payload: Schema.Struct({ delta: Schema.String }),
});
export type AetherWsAssistantDeltaEvent = typeof AetherWsAssistantDeltaEvent.Type;

const AetherWsThinkingDeltaEvent = Schema.Struct({
  ...messageFields,
  kind: Schema.Literal("thinking.delta"),
  payload: Schema.Struct({ delta: Schema.String }),
});
export type AetherWsThinkingDeltaEvent = typeof AetherWsThinkingDeltaEvent.Type;

const AetherWsStreamCompleteEvent = Schema.Struct({
  ...messageFields,
  kind: Schema.Literal("stream.complete"),
});
export type AetherWsStreamCompleteEvent = typeof AetherWsStreamCompleteEvent.Type;

const AetherWsAssistantCompletedEvent = Schema.Struct({
  ...messageFields,
  kind: Schema.Literal("assistant_message.completed"),
  payload: Schema.Struct({ content: Schema.String }),
});
export type AetherWsAssistantCompletedEvent = typeof AetherWsAssistantCompletedEvent.Type;

const AetherWsThinkingCompletedEvent = Schema.Struct({
  ...messageFields,
  kind: Schema.Literal("thinking.completed"),
  payload: Schema.Struct({ content: Schema.String }),
});
export type AetherWsThinkingCompletedEvent = typeof AetherWsThinkingCompletedEvent.Type;

const AetherWsTurnCompletedEvent = Schema.Struct({
  ...envelopeFields,
  kind: Schema.Literal("turn.completed"),
  turnId: Schema.String,
  payload: Schema.Struct({ status: Schema.String }),
});
export type AetherWsTurnCompletedEvent = typeof AetherWsTurnCompletedEvent.Type;

/**
 * The LIVE awaiting-input shape (messages.ts:377-384): `pendingInputId` +
 * `payload.{toolName, input}`. There is deliberately NO `kind` discriminator
 * and NO `tool_id` here — those exist only on the persisted REST projection
 * (spec resolved note 12). `pendingInputId` names the same pending input as
 * the REST `tool_id`.
 */
const AetherWsTurnAwaitingInputEvent = Schema.Struct({
  ...envelopeFields,
  kind: Schema.Literal("turn.awaiting_input"),
  turnId: Schema.String,
  pendingInputId: Schema.String,
  toolCallId: Schema.String,
  payload: Schema.Struct({
    toolName: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
  }),
});
export type AetherWsTurnAwaitingInputEvent = typeof AetherWsTurnAwaitingInputEvent.Type;

const AetherWsTurnFailedEvent = Schema.Struct({
  ...envelopeFields,
  kind: Schema.Literal("turn.failed"),
  turnId: Schema.String,
  payload: Schema.Struct({ errorMessage: Schema.String }),
});
export type AetherWsTurnFailedEvent = typeof AetherWsTurnFailedEvent.Type;

const AetherWsConversationTruncatedEvent = Schema.Struct({
  ...messageFields,
  kind: Schema.Literal("conversation.truncated"),
  payload: Schema.Struct({ anchorMessageId: Schema.String }),
});
export type AetherWsConversationTruncatedEvent = typeof AetherWsConversationTruncatedEvent.Type;

// Payload deliberately untyped: t3 has no slash-command surface for cloud
// sessions yet; the event is acknowledged and dropped (logged once).
const AetherWsSlashCommandsUpdatedEvent = Schema.Struct({
  ...envelopeFields,
  kind: Schema.Literal("slash_commands.updated"),
});
export type AetherWsSlashCommandsUpdatedEvent = typeof AetherWsSlashCommandsUpdatedEvent.Type;

/** The full parsed agent event union — all 13 wire kinds. */
export type AetherAgentEvent =
  | AetherWsToolCallEvent
  | AetherWsAssistantDeltaEvent
  | AetherWsThinkingDeltaEvent
  | AetherWsStreamCompleteEvent
  | AetherWsAssistantCompletedEvent
  | AetherWsThinkingCompletedEvent
  | AetherWsTurnCompletedEvent
  | AetherWsTurnAwaitingInputEvent
  | AetherWsTurnFailedEvent
  | AetherWsConversationTruncatedEvent
  | AetherWsSlashCommandsUpdatedEvent;

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

export type AetherFrameParseResult =
  /** A fully parsed agent task event. */
  | { readonly _tag: "event"; readonly event: AetherAgentEvent }
  /** A frame for another channel / message type — not ours, silently skipped. */
  | { readonly _tag: "ignored"; readonly channel: string; readonly type: string }
  /**
   * A `channel:"error"` frame — the workspace-service reporting ITS OWN
   * failure (initialization error before a close, or strict-parse rejection
   * of a client message with the socket left open). NOT another multiplexed
   * channel: silently skipping it leaves a connected-but-mute socket with
   * zero diagnostics under protocol skew. The caller must surface it.
   */
  | { readonly _tag: "server-error"; readonly detail: string }
  /** An agent task event whose kind this build does not know. Log once, drop. */
  | { readonly _tag: "unknown-kind"; readonly kind: string }
  /** Not JSON, no envelope, or a KNOWN kind whose payload failed to parse. */
  | { readonly _tag: "malformed"; readonly kind: string | undefined; readonly detail: string };

const decodeJsonFrame = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelopeProbe = Schema.decodeUnknownResult(
  Schema.Struct({ channel: Schema.String, type: Schema.String }),
);
const decodeKindProbe = Schema.decodeUnknownResult(Schema.Struct({ kind: Schema.String }));
// The server error frame is `{channel:"error", type:"error", error: string}`
// (workspace-service server.ts); probed loosely like everything else.
const decodeErrorProbe = Schema.decodeUnknownResult(Schema.Struct({ error: Schema.String }));

const decodeToolCall = Schema.decodeUnknownResult(AetherWsToolCallEvent);
const decodeAssistantDelta = Schema.decodeUnknownResult(AetherWsAssistantDeltaEvent);
const decodeThinkingDelta = Schema.decodeUnknownResult(AetherWsThinkingDeltaEvent);
const decodeStreamComplete = Schema.decodeUnknownResult(AetherWsStreamCompleteEvent);
const decodeAssistantCompleted = Schema.decodeUnknownResult(AetherWsAssistantCompletedEvent);
const decodeThinkingCompleted = Schema.decodeUnknownResult(AetherWsThinkingCompletedEvent);
const decodeTurnCompleted = Schema.decodeUnknownResult(AetherWsTurnCompletedEvent);
const decodeTurnAwaitingInput = Schema.decodeUnknownResult(AetherWsTurnAwaitingInputEvent);
const decodeTurnFailed = Schema.decodeUnknownResult(AetherWsTurnFailedEvent);
const decodeConversationTruncated = Schema.decodeUnknownResult(AetherWsConversationTruncatedEvent);
const decodeSlashCommandsUpdated = Schema.decodeUnknownResult(AetherWsSlashCommandsUpdatedEvent);

const decodeByKind = (
  kind: string,
  frame: unknown,
): Result.Result<AetherAgentEvent, Schema.SchemaError> | undefined => {
  switch (kind) {
    case "tool_call.started":
    case "tool_call.completed":
    case "tool_call.failed":
      return decodeToolCall(frame);
    case "assistant_message.delta":
      return decodeAssistantDelta(frame);
    case "thinking.delta":
      return decodeThinkingDelta(frame);
    case "stream.complete":
      return decodeStreamComplete(frame);
    case "assistant_message.completed":
      return decodeAssistantCompleted(frame);
    case "thinking.completed":
      return decodeThinkingCompleted(frame);
    case "turn.completed":
      return decodeTurnCompleted(frame);
    case "turn.awaiting_input":
      return decodeTurnAwaitingInput(frame);
    case "turn.failed":
      return decodeTurnFailed(frame);
    case "conversation.truncated":
      return decodeConversationTruncated(frame);
    case "slash_commands.updated":
      return decodeSlashCommandsUpdated(frame);
    default:
      return undefined;
  }
};

/**
 * Parse one raw WS frame into the tolerant result union. Pure and
 * synchronous, and it NEVER throws: every problem is an explicit carrier so
 * the socket loop can log-and-drop without a catch-all that would also
 * swallow real bugs.
 */
export function parseAetherAgentFrame(raw: string): AetherFrameParseResult {
  const json = decodeJsonFrame(raw);
  if (Result.isFailure(json)) {
    return { _tag: "malformed", kind: undefined, detail: "Frame is not valid JSON." };
  }
  const frame: unknown = json.success;

  const envelope = decodeEnvelopeProbe(frame);
  if (Result.isFailure(envelope)) {
    return {
      _tag: "malformed",
      kind: undefined,
      detail: "Frame carries no {channel, type} envelope.",
    };
  }
  if (envelope.success.channel === "error") {
    const probe = decodeErrorProbe(frame);
    return {
      _tag: "server-error",
      detail: Result.isSuccess(probe)
        ? probe.success.error
        : "server sent an error frame carrying no string `error` field",
    };
  }
  if (envelope.success.channel !== "agent" || envelope.success.type !== "task_event") {
    return { _tag: "ignored", channel: envelope.success.channel, type: envelope.success.type };
  }

  const probe = decodeKindProbe(frame);
  if (Result.isFailure(probe)) {
    return {
      _tag: "malformed",
      kind: undefined,
      detail: "Agent task event carries no string `kind`.",
    };
  }

  const decoded = decodeByKind(probe.success.kind, frame);
  if (decoded === undefined) {
    return { _tag: "unknown-kind", kind: probe.success.kind };
  }
  if (Result.isFailure(decoded)) {
    return {
      _tag: "malformed",
      kind: probe.success.kind,
      detail: `Known event kind '${probe.success.kind}' failed to parse: ${String(decoded.failure)}`,
    };
  }
  return { _tag: "event", event: decoded.success };
}
