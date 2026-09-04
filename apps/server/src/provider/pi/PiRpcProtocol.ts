import * as Schema from "effect/Schema";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const OpenStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [UnknownRecord]);

export class PiRpcProtocolError extends Schema.TaggedErrorClass<PiRpcProtocolError>()(
  "PiRpcProtocolError",
  {
    operation: Schema.Literals(["frame", "parse-json", "decode-message"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

export const PiRpcEnvelope = OpenStruct({ type: Schema.String.check(Schema.isNonEmpty()) });
export type PiRpcEnvelope = typeof PiRpcEnvelope.Type;

export const PiRpcResponse = OpenStruct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.Literal("response"),
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
});
export type PiRpcResponse = typeof PiRpcResponse.Type;

export const PiRpcAssistantMessageEvent = OpenStruct({
  type: Schema.Literals([
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
  ]),
  contentIndex: Schema.Number,
  delta: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
  toolCall: Schema.optionalKey(Schema.Unknown),
});
export type PiRpcAssistantMessageEvent = typeof PiRpcAssistantMessageEvent.Type;

export const PiRpcMessageUpdateEvent = OpenStruct({
  type: Schema.Literal("message_update"),
  usage: Schema.optionalKey(Schema.Unknown),
  assistantMessageEvent: PiRpcAssistantMessageEvent,
});
export type PiRpcMessageUpdateEvent = typeof PiRpcMessageUpdateEvent.Type;

const PiRpcToolContent = Schema.Array(
  OpenStruct({
    type: Schema.String,
    text: Schema.optionalKey(Schema.String),
  }),
);

const PiRpcToolResult = OpenStruct({
  content: PiRpcToolContent,
  details: Schema.optionalKey(Schema.Unknown),
});

export const PiRpcToolExecutionStartEvent = OpenStruct({
  type: Schema.Literal("tool_execution_start"),
  toolCallId: Schema.String.check(Schema.isNonEmpty()),
  toolName: Schema.String.check(Schema.isNonEmpty()),
  args: Schema.Unknown,
});
export type PiRpcToolExecutionStartEvent = typeof PiRpcToolExecutionStartEvent.Type;

export const PiRpcToolExecutionUpdateEvent = OpenStruct({
  type: Schema.Literal("tool_execution_update"),
  toolCallId: Schema.String.check(Schema.isNonEmpty()),
  toolName: Schema.String.check(Schema.isNonEmpty()),
  args: Schema.Unknown,
  partialResult: PiRpcToolResult,
});
export type PiRpcToolExecutionUpdateEvent = typeof PiRpcToolExecutionUpdateEvent.Type;

export const PiRpcToolExecutionEndEvent = OpenStruct({
  type: Schema.Literal("tool_execution_end"),
  toolCallId: Schema.String.check(Schema.isNonEmpty()),
  toolName: Schema.String.check(Schema.isNonEmpty()),
  result: PiRpcToolResult,
  isError: Schema.Boolean,
});
export type PiRpcToolExecutionEndEvent = typeof PiRpcToolExecutionEndEvent.Type;

const PiRpcExtensionUIBase = {
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String.check(Schema.isNonEmpty()),
};

export const PiRpcExtensionUIRequest = Schema.Union([
  OpenStruct({
    ...PiRpcExtensionUIBase,
    method: Schema.Literal("select"),
    title: Schema.String.check(Schema.isNonEmpty()),
    options: Schema.Array(Schema.String),
    timeout: Schema.optionalKey(Schema.Number),
  }),
  OpenStruct({
    ...PiRpcExtensionUIBase,
    method: Schema.Literal("confirm"),
    title: Schema.String.check(Schema.isNonEmpty()),
    message: Schema.String,
    timeout: Schema.optionalKey(Schema.Number),
  }),
  OpenStruct({
    ...PiRpcExtensionUIBase,
    method: Schema.Literal("input"),
    title: Schema.String.check(Schema.isNonEmpty()),
    placeholder: Schema.optionalKey(Schema.String),
    timeout: Schema.optionalKey(Schema.Number),
  }),
  OpenStruct({
    ...PiRpcExtensionUIBase,
    method: Schema.Literal("editor"),
    title: Schema.String.check(Schema.isNonEmpty()),
    prefill: Schema.optionalKey(Schema.String),
  }),
  OpenStruct({
    ...PiRpcExtensionUIBase,
    method: Schema.Literals(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]),
  }),
]);
export type PiRpcExtensionUIRequest = typeof PiRpcExtensionUIRequest.Type;

export const PiRpcAgentSettledEvent = OpenStruct({ type: Schema.Literal("agent_settled") });
export const PiRpcAgentStartEvent = OpenStruct({ type: Schema.Literal("agent_start") });
export const PiRpcAgentEndEvent = OpenStruct({
  type: Schema.Literal("agent_end"),
  messages: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  willRetry: Schema.optionalKey(Schema.Boolean),
});
export const PiRpcCompactionStartEvent = OpenStruct({
  type: Schema.Literal("compaction_start"),
  reason: Schema.Literals(["manual", "threshold", "overflow"]),
});
export const PiRpcCompactionEndEvent = OpenStruct({
  type: Schema.Literal("compaction_end"),
  reason: Schema.Literals(["manual", "threshold", "overflow"]),
  result: Schema.Unknown,
  aborted: Schema.Boolean,
  willRetry: Schema.Boolean,
  errorMessage: Schema.optionalKey(Schema.String),
});

export const PiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionFile: Schema.String.check(Schema.isNonEmpty()),
  sessionId: Schema.String.check(Schema.isNonEmpty()),
  lastEntryId: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
});
export type PiResumeCursor = typeof PiResumeCursor.Type;

export type PiImageContent = {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
};

export type PiRpcCommand =
  | {
      readonly id?: string;
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiImageContent>;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | {
      readonly id?: string;
      readonly type: "steer" | "follow_up";
      readonly message: string;
      readonly images?: ReadonlyArray<PiImageContent>;
    }
  | {
      readonly id?: string;
      readonly type: "abort" | "clear_queue" | "get_state" | "get_available_models";
    }
  | {
      readonly id?: string;
      readonly type: "get_available_thinking_levels" | "get_commands" | "get_entries";
      readonly since?: string;
    }
  | {
      readonly id?: string;
      readonly type: "set_model";
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly id?: string; readonly type: "set_thinking_level"; readonly level: string }
  | { readonly id?: string; readonly type: "compact"; readonly customInstructions?: string }
  | { readonly id?: string; readonly type: "switch_session"; readonly sessionPath: string }
  | { readonly id?: string; readonly type: "set_session_name"; readonly name: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

const decodeEnvelope = Schema.decodeUnknownSync(PiRpcEnvelope);

export function decodePiRpcMessage(input: unknown): PiRpcEnvelope {
  try {
    return decodeEnvelope(input);
  } catch {
    throw new PiRpcProtocolError({
      operation: "decode-message",
      detail: "message must be an object with a non-empty type",
    });
  }
}

export function encodePiRpcCommand(command: PiRpcCommand): string {
  return `${JSON.stringify(command)}\n`;
}

export interface PiJsonlDecoder {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<PiRpcEnvelope>;
  readonly end: () => ReadonlyArray<PiRpcEnvelope>;
}

export function makePiJsonlDecoder(options?: { readonly maxLineBytes?: number }): PiJsonlDecoder {
  const maxLineBytes = options?.maxLineBytes ?? 4 * 1024 * 1024;
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  let segments: Uint8Array[] = [];
  let bufferedBytes = 0;

  const append = (segment: Uint8Array): void => {
    if (segment.byteLength === 0) return;
    bufferedBytes += segment.byteLength;
    if (bufferedBytes > maxLineBytes) {
      throw new PiRpcProtocolError({
        operation: "frame",
        detail: `record exceeded ${maxLineBytes} bytes`,
      });
    }
    segments.push(segment.slice());
  };

  const consume = (): PiRpcEnvelope | undefined => {
    if (bufferedBytes === 0) {
      segments = [];
      return undefined;
    }
    const record = new Uint8Array(bufferedBytes);
    let offset = 0;
    for (const segment of segments) {
      record.set(segment, offset);
      offset += segment.byteLength;
    }
    segments = [];
    bufferedBytes = 0;
    const end = record.at(-1) === 0x0d ? record.byteLength - 1 : record.byteLength;
    let text: string;
    try {
      text = textDecoder.decode(record.subarray(0, end));
    } catch {
      throw new PiRpcProtocolError({
        operation: "parse-json",
        detail: "record was not valid UTF-8",
      });
    }
    if (text.length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PiRpcProtocolError({
        operation: "parse-json",
        detail: "record contained invalid JSON",
      });
    }
    return decodePiRpcMessage(parsed);
  };

  return {
    push: (chunk) => {
      const messages: PiRpcEnvelope[] = [];
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        append(chunk.subarray(start, index));
        const message = consume();
        if (message !== undefined) messages.push(message);
        start = index + 1;
      }
      append(chunk.subarray(start));
      return messages;
    },
    end: () => {
      const message = consume();
      return message === undefined ? [] : [message];
    },
  };
}

export interface CumulativeToolOutputState {
  readonly length: number;
  readonly tail: string;
}

export function cumulativeToolOutputDelta(
  previous: CumulativeToolOutputState | undefined,
  current: string,
  maxRetainedChars = 64 * 1024,
): {
  readonly delta: string;
  readonly state: CumulativeToolOutputState;
  readonly replaced: boolean;
} {
  const tail = current.slice(-maxRetainedChars);
  const state = { length: current.length, tail } satisfies CumulativeToolOutputState;
  if (previous === undefined) {
    return { delta: tail, state, replaced: current.length > maxRetainedChars };
  }
  const overlapStart = Math.max(0, previous.length - previous.tail.length);
  const prefixStillMatches =
    current.length >= previous.length &&
    current.slice(overlapStart, previous.length) === previous.tail;
  if (prefixStillMatches) {
    const delta = current.slice(previous.length);
    if (delta.length > maxRetainedChars) return { delta: tail, state, replaced: true };
    return {
      delta,
      state,
      replaced: false,
    };
  }
  return {
    delta: tail,
    state,
    replaced: true,
  };
}

export const isPiRpcResponse = Schema.is(PiRpcResponse);
export const isPiRpcMessageUpdateEvent = Schema.is(PiRpcMessageUpdateEvent);
export const isPiRpcToolExecutionStartEvent = Schema.is(PiRpcToolExecutionStartEvent);
export const isPiRpcToolExecutionUpdateEvent = Schema.is(PiRpcToolExecutionUpdateEvent);
export const isPiRpcToolExecutionEndEvent = Schema.is(PiRpcToolExecutionEndEvent);
export const isPiRpcExtensionUIRequest = Schema.is(PiRpcExtensionUIRequest);
export const isPiRpcAgentSettledEvent = Schema.is(PiRpcAgentSettledEvent);
export const isPiRpcAgentStartEvent = Schema.is(PiRpcAgentStartEvent);
export const isPiRpcAgentEndEvent = Schema.is(PiRpcAgentEndEvent);
export const isPiRpcCompactionStartEvent = Schema.is(PiRpcCompactionStartEvent);
export const isPiRpcCompactionEndEvent = Schema.is(PiRpcCompactionEndEvent);
