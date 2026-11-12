import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpSchemaV1 from "effect-acp/schema-v1";
import type {
  OrchestrationV2ProviderThreadNativeMetadata,
  ThreadTokenUsageSnapshot,
  ToolLifecycleItemType,
} from "@t3tools/contracts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Modes were removed from ACP v2, so the v1 wire schema is the source of truth.
export const isSessionModelState = Schema.is(EffectAcpSchema.SessionModelState);
export const isSessionModeState = Schema.is(EffectAcpSchemaV1.SessionModeState);

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<AcpSessionMode>;
}

export interface AcpToolCallState {
  readonly toolCallId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly status?: "pending" | "inProgress" | "requiresAction" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
}

export interface AcpAgentTerminalState {
  readonly command?: string;
  readonly cwd?: string;
  readonly output: string;
  /** UTF-8 byte length of `output`, so appending a chunk never re-encodes the buffer. */
  readonly outputBytes: number;
  readonly exitStatus?: EffectAcpSchema.TerminalExitStatus;
  readonly pendingOutputBytes?: Uint8Array;
}

export type AcpAgentTerminalUpdate = Extract<
  EffectAcpSchema.SessionUpdate,
  { readonly sessionUpdate: "terminal_update" | "terminal_output_chunk" }
>;

export const MAX_ACP_TERMINAL_OUTPUT_BYTES = 16 * 1024 * 1024;
export const ACP_TERMINAL_OUTPUT_TRIM_BYTES = 1024 * 1024;
export const MAX_ACP_TERMINAL_FRAME_BYTES = MAX_ACP_TERMINAL_OUTPUT_BYTES;

export function isBase64DataCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

export function decodeBase64TerminalFrame(encoded: string): Uint8Array | undefined {
  if (encoded.length > Math.ceil(MAX_ACP_TERMINAL_FRAME_BYTES / 3) * 4) {
    return undefined;
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const dataLength = encoded.length - padding;
  if (
    encoded.length % 4 === 1 ||
    (padding > 0 && encoded.length % 4 !== 0) ||
    (padding === 1 && dataLength % 4 !== 3) ||
    (padding === 2 && dataLength % 4 !== 2)
  ) {
    return undefined;
  }
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64DataCode(encoded.charCodeAt(index))) return undefined;
  }
  const decoded = Buffer.from(encoded, "base64");
  return decoded.byteLength <= MAX_ACP_TERMINAL_FRAME_BYTES ? decoded : undefined;
}

export function trailingIncompleteUtf8Start(bytes: Uint8Array): number {
  if (bytes.length === 0) return bytes.length;
  let leadIndex = bytes.length - 1;
  while (leadIndex >= 0 && (bytes[leadIndex]! & 0xc0) === 0x80) {
    leadIndex -= 1;
  }
  if (leadIndex < 0) return bytes.length;
  const lead = bytes[leadIndex]!;
  const expectedLength =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  return bytes.length - leadIndex < expectedLength ? leadIndex : bytes.length;
}

export function decodeTerminalOutputChunk(
  pending: Uint8Array | undefined,
  encoded: string,
): { readonly text: string; readonly pendingOutputBytes?: Uint8Array } | undefined {
  const frame = decodeBase64TerminalFrame(encoded);
  if (frame === undefined) return undefined;
  const bytes = Buffer.concat([...(pending === undefined ? [] : [Buffer.from(pending)]), frame]);
  const completeEnd = trailingIncompleteUtf8Start(bytes);
  const text = bytes.subarray(0, completeEnd).toString("utf8");
  return completeEnd === bytes.length
    ? { text }
    : { text, pendingOutputBytes: Uint8Array.from(bytes.subarray(completeEnd)) };
}

// Drop an extra batch at UTF-8 boundaries so flattening the retained string is amortized.
export function appendTerminalOutput(
  output: string,
  outputBytes: number,
  text: string,
): Pick<AcpAgentTerminalState, "output" | "outputBytes"> {
  const combined = `${output}${text}`;
  const combinedBytes = outputBytes + Buffer.byteLength(text, "utf8");
  const excess = combinedBytes - MAX_ACP_TERMINAL_OUTPUT_BYTES;
  if (excess <= 0) return { output: combined, outputBytes: combinedBytes };
  let start = 0;
  let dropped = 0;
  while (dropped < excess + ACP_TERMINAL_OUTPUT_TRIM_BYTES) {
    const codePoint = combined.codePointAt(start)!;
    dropped += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    start += codePoint < 0x10000 ? 1 : 2;
  }
  return { output: combined.slice(start), outputBytes: combinedBytes - dropped };
}

export function applyAcpAgentTerminalUpdate(
  previous: AcpAgentTerminalState | undefined,
  update: AcpAgentTerminalUpdate,
): AcpAgentTerminalState {
  const current = previous ?? { output: "", outputBytes: 0 };
  if (update.sessionUpdate === "terminal_output_chunk") {
    const decoded = decodeTerminalOutputChunk(current.pendingOutputBytes, update.data);
    if (decoded === undefined) return current;
    const { pendingOutputBytes: _pendingOutputBytes, ...withoutPendingOutputBytes } = current;
    return {
      ...withoutPendingOutputBytes,
      ...appendTerminalOutput(current.output, current.outputBytes, decoded.text),
      ...(decoded.pendingOutputBytes === undefined
        ? {}
        : { pendingOutputBytes: decoded.pendingOutputBytes }),
    };
  }
  let next: AcpAgentTerminalState = current;
  if (update.command === null) {
    const { command: _command, ...withoutCommand } = next;
    next = withoutCommand;
  } else if (update.command !== undefined) {
    next = { ...next, command: update.command };
  }
  if (update.cwd === null) {
    const { cwd: _cwd, ...withoutCwd } = next;
    next = withoutCwd;
  } else if (update.cwd !== undefined) {
    next = { ...next, cwd: update.cwd };
  }
  if (update.output !== undefined) {
    const decoded =
      update.output === null
        ? { text: "" }
        : decodeTerminalOutputChunk(undefined, update.output.data);
    if (decoded !== undefined) {
      const { pendingOutputBytes: _pendingOutputBytes, ...withoutPendingOutputBytes } = next;
      next = {
        ...withoutPendingOutputBytes,
        ...appendTerminalOutput("", 0, decoded.text),
        ...(decoded.pendingOutputBytes === undefined
          ? {}
          : { pendingOutputBytes: decoded.pendingOutputBytes }),
      };
    }
  }
  if (update.exitStatus === null) {
    const { exitStatus: _exitStatus, ...withoutExitStatus } = next;
    next = withoutExitStatus;
  } else if (update.exitStatus !== undefined) {
    const pendingText =
      next.pendingOutputBytes === undefined
        ? ""
        : Buffer.from(next.pendingOutputBytes).toString("utf8");
    const { pendingOutputBytes: _pendingOutputBytes, ...withoutPendingOutputBytes } = next;
    next = {
      ...withoutPendingOutputBytes,
      ...appendTerminalOutput(next.output, next.outputBytes, pendingText),
      exitStatus: update.exitStatus,
    };
  }
  return next;
}

export type AcpPlanUpdate =
  | {
      readonly nativePlanId: string;
      readonly kind: "items";
      readonly explanation?: string | null;
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed" | "cancelled";
      }>;
    }
  | { readonly nativePlanId: string; readonly kind: "markdown"; readonly markdown: string }
  | { readonly nativePlanId: string; readonly kind: "file"; readonly uri: string }
  | { readonly nativePlanId: string; readonly kind: "unknown"; readonly contentType: string }
  | { readonly nativePlanId: string; readonly kind: "removed" };

export interface AcpPermissionRequest {
  readonly kind: string | "unknown";
  readonly detail?: string;
  readonly toolCall?: AcpToolCallState;
}

export type AcpParsedSessionEvent =
  | {
      readonly _tag: "ModeChanged";
      readonly modeId: string;
    }
  | {
      readonly _tag: "AvailableCommandsUpdated";
      readonly availableCommands: ReadonlyArray<EffectAcpSchema.AvailableCommand>;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ConfigOptionsUpdated";
      readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "AssistantItemStarted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "AssistantItemCompleted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "PlanUpdated";
      readonly payload: AcpPlanUpdate;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ToolCallUpdated";
      readonly toolCall: AcpToolCallState;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ContentDelta";
      readonly itemId?: string;
      readonly messageId?: string;
      readonly text: string;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ThoughtDelta";
      readonly text: string;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "UsageUpdated";
      readonly usage: ThreadTokenUsageSnapshot;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "SessionInfoUpdated";
      readonly metadata: OrchestrationV2ProviderThreadNativeMetadata;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "NoticeReceived";
      readonly severity: string;
      readonly title: string;
      readonly description?: string;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "UnknownUpdate";
      readonly updateType: string;
      readonly rawPayload: unknown;
    };

export type AcpSessionSetupResponse =
  | EffectAcpSchema.ForkSessionResponse
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

export type AcpToolCallUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

export type AcpSelectConfigOption = Extract<
  EffectAcpSchema.SessionConfigOption,
  { readonly type: "select" }
>;

// ACP resolves options in the same category by array order.
export interface ExtractedToolCallContent {
  readonly text: string | undefined;
  readonly content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | undefined;
}

export interface AcpToolCallEmitDecisionInput {
  readonly previous: AcpToolCallState | undefined;
  readonly next: AcpToolCallState;
  readonly lastEmittedDetailLength: number | undefined;
  readonly skippedSinceEmit: number;
}

export interface AcpToolCallEmitDecision {
  readonly emit: boolean;
  readonly skippedSinceEmit: number;
}

export interface AcpMcpToolCallIdentity {
  readonly server: string;
  readonly tool: string;
  readonly input?: Record<string, unknown>;
}

export interface SessionLoadGate {
  readonly active: boolean;
  readonly sessionId: string;
  readonly lastActivityAtMillis: number | undefined;
  readonly idleGap: Duration.Duration;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly candidateConfigOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}

