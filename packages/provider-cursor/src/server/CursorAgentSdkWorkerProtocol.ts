import type {
  AgentMessage,
  AgentOptions,
  InteractionUpdate,
  RunResult,
  SDKUserMessage,
  SendOptions,
  SteerAckOutcome,
} from "@cursor/sdk";
import type { OrchestrationV2ProviderSession, ThreadId } from "@t3tools/contracts";

import type {
  CursorAgentSdkOpenInput,
  CursorAgentSdkProtocolLogEvent,
  CursorAgentSdkTextGenerateInput,
  CursorContextUsage,
} from "./CursorAgentSdk.ts";
import { type CursorSdkErrorKind, getCursorSdkErrorKind, tagCursorSdkError } from "./sdk.ts";

export interface SerializedWorkerError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly status?: number;
  readonly sdkErrorKind?: CursorSdkErrorKind;
  readonly cause?: SerializedWorkerError;
}

export interface SerializedRunnerFailure {
  readonly method: string;
  readonly cause: SerializedWorkerError;
}

export type SerializedRunResult = Omit<RunResult, "error"> & {
  readonly error?: SerializedWorkerError | undefined;
};

export type CursorWorkerRequest =
  | {
      readonly id: number;
      readonly type: "open";
      readonly operation: CursorAgentSdkOpenInput["operation"];
      readonly agentId?: string;
      readonly storeCwd?: string;
      readonly options: AgentOptions;
      readonly threadId: ThreadId;
      readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    }
  | {
      readonly id: number;
      readonly type: "send";
      readonly message: string | SDKUserMessage;
      readonly options?: Omit<SendOptions, "onDelta">;
      readonly summarize?: boolean;
      readonly resume?: boolean;
    }
  | {
      readonly id: number;
      readonly type: "steer";
      readonly sendId: number;
      readonly text: string;
    }
  | {
      readonly id: number;
      readonly type: "cancel";
      readonly sendId: number;
    }
  | {
      readonly id: number;
      readonly type: "listMessages";
    }
  | {
      readonly id: number;
      readonly type: "readContextUsage";
    }
  | {
      readonly id: number;
      readonly type: "runCheckpointed";
      readonly runId?: string;
    }
  | {
      readonly id: number;
      readonly type: "rewindAfterRun";
      readonly runId: string;
    }
  | {
      readonly id: number;
      readonly type: "close";
    }
  | ({
      readonly id: number;
      readonly type: "textGenerate";
    } & CursorAgentSdkTextGenerateInput);

export type CursorWorkerResponsePayload =
  | { readonly agentId: string }
  | { readonly runId: string; readonly agentId: string }
  | SteerAckOutcome
  | ReadonlyArray<AgentMessage>
  | CursorContextUsage
  | SerializedRunResult
  | boolean
  | null;

export type CursorWorkerMessage =
  | {
      readonly type: "response";
      readonly id: number;
      readonly ok: true;
      readonly result: CursorWorkerResponsePayload;
    }
  | {
      readonly type: "response";
      readonly id: number;
      readonly ok: false;
      readonly error: SerializedRunnerFailure;
    }
  | {
      readonly type: "delta";
      readonly sendId: number;
      readonly update: InteractionUpdate;
    }
  | {
      readonly type: "runDone";
      readonly sendId: number;
      readonly ok: true;
      readonly result: SerializedRunResult;
    }
  | {
      readonly type: "runDone";
      readonly sendId: number;
      readonly ok: false;
      readonly error: SerializedRunnerFailure;
    }
  | {
      readonly type: "protocolLog";
      readonly event: CursorAgentSdkProtocolLogEvent;
    };

const MAX_ERROR_CAUSE_DEPTH = 8;

export function serializeWorkerError(
  cause: unknown,
  depth = 0,
  seen = new Set<object>(),
): SerializedWorkerError {
  if (typeof cause === "object" && cause !== null) {
    if (seen.has(cause)) {
      return { name: "Error", message: "[Circular error cause]" };
    }
    seen.add(cause);
    const rawName = Reflect.get(cause, "name");
    const rawMessage = Reflect.get(cause, "message");
    const rawStack = Reflect.get(cause, "stack");
    const rawCode = Reflect.get(cause, "code");
    const rawStatus = Reflect.get(cause, "status");
    const rawCause = depth < MAX_ERROR_CAUSE_DEPTH ? Reflect.get(cause, "cause") : undefined;
    const sdkErrorKind = getCursorSdkErrorKind(cause);
    return {
      name: typeof rawName === "string" && rawName.length > 0 ? rawName : "Error",
      message: typeof rawMessage === "string" ? rawMessage : String(cause),
      ...(typeof rawStack === "string" ? { stack: rawStack } : {}),
      ...(typeof rawCode === "string" ? { code: rawCode } : {}),
      ...(typeof rawStatus === "number" ? { status: rawStatus } : {}),
      ...(sdkErrorKind === undefined ? {} : { sdkErrorKind }),
      ...(rawCause === undefined ? {} : { cause: serializeWorkerError(rawCause, depth + 1, seen) }),
    };
  }
  return {
    name: "Error",
    message: typeof cause === "string" ? cause : String(cause),
  };
}

export function deserializeWorkerError(serialized: SerializedWorkerError): Error {
  const error = new Error(
    serialized.message,
    serialized.cause === undefined
      ? undefined
      : { cause: deserializeWorkerError(serialized.cause) },
  );
  error.name = serialized.name;
  if (serialized.stack !== undefined) {
    error.stack = serialized.stack;
  }
  if (serialized.code !== undefined) {
    Reflect.set(error, "code", serialized.code);
  }
  if (serialized.status !== undefined) {
    Reflect.set(error, "status", serialized.status);
  }
  if (serialized.sdkErrorKind !== undefined) {
    tagCursorSdkError(error, serialized.sdkErrorKind);
  }
  return error;
}

export function serializeRunResult(result: RunResult): SerializedRunResult {
  if (result.error === undefined) {
    return result as SerializedRunResult;
  }
  return {
    ...result,
    error: serializeWorkerError(result.error),
  };
}

export function deserializeRunResult(result: SerializedRunResult): RunResult {
  if (result.error === undefined) {
    return result as RunResult;
  }
  return {
    ...result,
    error: deserializeWorkerError(result.error),
  } as RunResult;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }
  return value;
}

export function encodeWorkerFrame(frame: CursorWorkerRequest | CursorWorkerMessage): string {
  return `${JSON.stringify(frame, jsonReplacer)}\n`;
}

export function decodeWorkerFrame(line: string): unknown {
  return JSON.parse(line);
}
