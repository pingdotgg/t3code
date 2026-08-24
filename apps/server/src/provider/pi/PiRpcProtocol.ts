import * as Schema from "effect/Schema";

export class PiRpcProtocolError extends Error {
  readonly line: string | undefined;

  constructor(message: string, options?: { readonly line?: string; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PiRpcProtocolError";
    this.line = options?.line;
  }
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJsonString = Schema.decodeUnknownSync(UnknownFromJsonString);
const encodeUnknownJsonString = Schema.encodeUnknownSync(UnknownFromJsonString);

export function encodePiRpcJsonString(value: unknown): string {
  return encodeUnknownJsonString(value);
}

export interface PiRpcImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type PiRpcCommand =
  | {
      readonly id?: string;
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImageContent>;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | { readonly id?: string; readonly type: "steer"; readonly message: string }
  | { readonly id?: string; readonly type: "follow_up"; readonly message: string }
  | { readonly id?: string; readonly type: "abort" }
  | { readonly id?: string; readonly type: "get_state" }
  | { readonly id?: string; readonly type: "get_messages" }
  | { readonly id?: string; readonly type: "get_last_assistant_text" }
  | { readonly id?: string; readonly type: "get_available_models" }
  | { readonly id?: string; readonly type: "get_session_stats" }
  | {
      readonly id?: string;
      readonly type: "set_model";
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly id?: string; readonly type: "set_thinking_level"; readonly level: string }
  | { readonly id?: string; readonly type: "switch_session"; readonly sessionPath: string }
  | { readonly id?: string; readonly type: "set_session_name"; readonly name: string }
  | PiExtensionUIResponse;

export type PiExtensionUIResponse =
  | { readonly id: string; readonly type: "extension_ui_response"; readonly value: string }
  | { readonly id: string; readonly type: "extension_ui_response"; readonly confirmed: boolean }
  | { readonly id: string; readonly type: "extension_ui_response"; readonly cancelled: true };

export type PiRpcResponse =
  | {
      readonly id?: string;
      readonly type: "response";
      readonly command: string;
      readonly success: true;
      readonly data?: unknown;
    }
  | {
      readonly id?: string;
      readonly type: "response";
      readonly command: string;
      readonly success: false;
      readonly error: string;
    };

export type PiExtensionUIRequest = {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text";
  readonly [key: string]: unknown;
};

export type PiAgentEvent = {
  readonly type:
    | "agent_start"
    | "agent_end"
    | "turn_start"
    | "turn_end"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end"
    | "queue_update"
    | "compaction_start"
    | "compaction_end"
    | "auto_retry_start"
    | "auto_retry_end"
    | "extension_error"
    | "agent_settled"
    | "entry_appended"
    | "session_info_changed"
    | "thinking_level_changed";
  readonly [key: string]: unknown;
};

/**
 * Pi adds session lifecycle events independently of the request/response protocol.
 * Keep these records open so a new informational event cannot invalidate an entire
 * stdout chunk containing response deltas that we already understand.
 */
export type PiRpcEvent = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export type PiRpcOutput = PiRpcResponse | PiExtensionUIRequest | PiAgentEvent | PiRpcEvent;

export function isPiRpcResponse(output: PiRpcOutput): output is PiRpcResponse {
  return output.type === "response";
}

export function decodePiRpcJsonString(value: string): PiRpcOutput {
  return decodePiRpcOutput(decodeUnknownJsonString(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function decodePiRpcOutput(value: unknown): PiRpcOutput {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") {
    throw new PiRpcProtocolError("Pi RPC output must be an object with a string type.");
  }

  if (record.type === "response") {
    if (
      !optionalString(record.id) ||
      typeof record.command !== "string" ||
      typeof record.success !== "boolean"
    ) {
      throw new PiRpcProtocolError("Pi RPC response has invalid correlation fields.");
    }
    if (record.success === false && typeof record.error !== "string") {
      throw new PiRpcProtocolError("Failed Pi RPC response is missing its error message.");
    }
    return record as PiRpcResponse;
  }

  if (record.type === "extension_ui_request") {
    if (typeof record.id !== "string" || typeof record.method !== "string") {
      throw new PiRpcProtocolError("Pi extension UI request has invalid fields.");
    }
    return record as PiExtensionUIRequest;
  }

  return record as PiRpcEvent;
}

export interface PiRpcLineDecoder {
  readonly push: (chunk: string | Uint8Array) => ReadonlyArray<PiRpcOutput>;
  readonly finish: () => ReadonlyArray<PiRpcOutput>;
}

export function makePiRpcLineDecoder(): PiRpcLineDecoder {
  const textDecoder = new TextDecoder();
  let buffer = "";

  const decodeLine = (rawLine: string): PiRpcOutput | null => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) return null;
    try {
      return decodePiRpcJsonString(line);
    } catch (cause) {
      if (cause instanceof PiRpcProtocolError) throw cause;
      throw new PiRpcProtocolError("Pi RPC emitted malformed JSON.", {
        line: line.slice(0, 500),
        cause,
      });
    }
  };

  const drain = (): ReadonlyArray<PiRpcOutput> => {
    const records: PiRpcOutput[] = [];
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const record = decodeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (record) records.push(record);
      newline = buffer.indexOf("\n");
    }
    return records;
  };

  return {
    push: (chunk) => {
      buffer += typeof chunk === "string" ? chunk : textDecoder.decode(chunk, { stream: true });
      return drain();
    },
    finish: () => {
      buffer += textDecoder.decode();
      const records = drain();
      if (buffer.length > 0) {
        throw new PiRpcProtocolError("Pi RPC stream ended with an unterminated JSONL record.", {
          line: buffer.slice(0, 500),
        });
      }
      return records;
    },
  };
}
