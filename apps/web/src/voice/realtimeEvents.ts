import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const RealtimeId = Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(512));
const RealtimeText = Schema.String.check(Schema.isMaxLength(1_000_000));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const EventBase = {
  event_id: RealtimeId,
};

const SessionCreatedEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("session.created"),
  session: Schema.Struct({ id: RealtimeId }),
});

const SessionUpdatedEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("session.updated"),
  session: Schema.Struct({ id: RealtimeId }),
});

const SpeechStartedEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("input_audio_buffer.speech_started"),
  item_id: RealtimeId,
  audio_start_ms: NonNegativeInt,
});

const SpeechStoppedEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("input_audio_buffer.speech_stopped"),
  item_id: RealtimeId,
  audio_end_ms: NonNegativeInt,
});

const InputTranscriptDeltaEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("conversation.item.input_audio_transcription.delta"),
  item_id: RealtimeId,
  delta: RealtimeText,
});

const InputTranscriptCompletedEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("conversation.item.input_audio_transcription.completed"),
  item_id: RealtimeId,
  transcript: RealtimeText,
});

const RealtimeErrorDetail = Schema.Struct({
  event_id: Schema.optionalKey(RealtimeId),
  type: Schema.optionalKey(RealtimeId),
  code: Schema.optionalKey(Schema.NullOr(RealtimeId)),
  message: Schema.optionalKey(RealtimeText),
});

const InputTranscriptFailedEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("conversation.item.input_audio_transcription.failed"),
  item_id: RealtimeId,
  error: RealtimeErrorDetail,
});

const OutputTranscriptDeltaEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("response.output_audio_transcript.delta"),
  response_id: RealtimeId,
  item_id: RealtimeId,
  delta: RealtimeText,
});

const OutputTranscriptDoneEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("response.output_audio_transcript.done"),
  response_id: RealtimeId,
  item_id: RealtimeId,
  transcript: RealtimeText,
});

const ResponseCreatedEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("response.created"),
  response: Schema.Struct({
    id: RealtimeId,
    status: RealtimeId,
  }),
});

const ResponseDoneEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("response.done"),
  response: Schema.Struct({
    id: RealtimeId,
    status: RealtimeId,
    output: Schema.Array(Schema.Unknown),
  }),
});

const ErrorEvent = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("error"),
  error: RealtimeErrorDetail,
});

/**
 * The intentionally small set of Realtime events consumed by the voice UI.
 * Unknown event kinds remain forward-compatible by being ignored at the data
 * channel boundary instead of widening this into a mirror of OpenAI's API.
 */
export const RealtimeServerEvent = Schema.Union([
  SessionCreatedEvent,
  SessionUpdatedEvent,
  SpeechStartedEvent,
  SpeechStoppedEvent,
  InputTranscriptDeltaEvent,
  InputTranscriptCompletedEvent,
  InputTranscriptFailedEvent,
  OutputTranscriptDeltaEvent,
  OutputTranscriptDoneEvent,
  ResponseCreatedEvent,
  ResponseDoneEvent,
  ErrorEvent,
]);
export type RealtimeServerEvent = typeof RealtimeServerEvent.Type;

const FunctionCallItem = Schema.Struct({
  id: RealtimeId,
  type: Schema.Literal("function_call"),
  call_id: RealtimeId,
  name: RealtimeId,
  arguments: RealtimeText,
  status: Schema.optionalKey(Schema.Literals(["completed", "in_progress", "incomplete"])),
});

export interface RealtimeFunctionCall {
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

export const MAX_REALTIME_EVENT_JSON_CHARS = 2_000_000;

const decodeServerEvent = Schema.decodeUnknownOption(RealtimeServerEvent);
const decodeFunctionCallItem = Schema.decodeUnknownOption(FunctionCallItem);

export function decodeRealtimeServerEvent(value: unknown): RealtimeServerEvent | null {
  return Option.getOrNull(decodeServerEvent(value));
}

/** Parse one data-channel message. Binary, oversized, unknown, and malformed messages are ignored. */
export function decodeRealtimeServerEventMessage(data: unknown): RealtimeServerEvent | null {
  if (typeof data !== "string" || data.length > MAX_REALTIME_EVENT_JSON_CHARS) return null;
  try {
    return decodeRealtimeServerEvent(JSON.parse(data));
  } catch {
    return null;
  }
}

/**
 * Function calls are consumed only from the canonical, complete `response.done`
 * output. Streaming argument events are deliberately ignored so a partial call
 * can never escape into the tool executor.
 */
export function extractRealtimeFunctionCalls(
  event: RealtimeServerEvent,
): ReadonlyArray<RealtimeFunctionCall> {
  if (event.type !== "response.done" || event.response.status !== "completed") return [];

  const calls: RealtimeFunctionCall[] = [];
  for (const output of event.response.output) {
    const decoded = decodeFunctionCallItem(output);
    if (
      Option.isNone(decoded) ||
      (decoded.value.status !== undefined && decoded.value.status !== "completed")
    ) {
      continue;
    }
    calls.push({
      itemId: decoded.value.id,
      callId: decoded.value.call_id,
      name: decoded.value.name,
      arguments: decoded.value.arguments,
    });
  }
  return calls;
}
