// @effect-diagnostics nodeBuiltinImport:off -- fixtures use Node builtins
import { ClaudeSettings } from "@t3tools/contracts";
import {
  forkSession,
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import {
  ProviderReplayEntry,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import {
  isWindowsClaudeLauncherShimPath,
  resolveClaudeSdkExecutablePath,
} from "../../provider/Drivers/ClaudeExecutable.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { claudeTaskOutputRoot } from "./ClaudeTaskOutputTail.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import {
  replayQueryRunnerError,
  sanitizedReplayCwd,
} from "./ClaudeAdapterV2.testkit.ts";
export const CLAUDE_AGENT_SDK_REPLAY_PROTOCOL = "claude-agent-sdk.query" as const;
export const claudeBackgroundWakeResultLabel = (wakeNumber: number) =>
  `result:background-wake:${wakeNumber}`;

export const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

export const ClaudeAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(ClaudeAdapterV2.CLAUDE_PROVIDER),
  protocol: Schema.Literal(CLAUDE_AGENT_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type ClaudeAgentSdkReplayTranscript = typeof ClaudeAgentSdkReplayTranscript.Type;

export class ClaudeReplayTranscriptDecodeError extends Schema.TaggedError<ClaudeReplayTranscriptDecodeError>()(
  "ClaudeReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Claude Agent SDK replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export class ClaudeReplayExhaustedError extends Schema.TaggedError<ClaudeReplayExhaustedError>()(
  "ClaudeReplayExhaustedError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay transcript exhausted before outbound frame ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayUnexpectedOutboundError extends Schema.TaggedError<ClaudeReplayUnexpectedOutboundError>()(
  "ClaudeReplayUnexpectedOutboundError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expectedType: Schema.String,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Unexpected outbound Claude Agent SDK frame at replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayFrameMismatchError extends Schema.TaggedError<ClaudeReplayFrameMismatchError>()(
  "ClaudeReplayFrameMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Outbound Claude Agent SDK frame did not match replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayRuntimeExitError extends Schema.TaggedError<ClaudeReplayRuntimeExitError>()(
  "ClaudeReplayRuntimeExitError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    status: Schema.Literals(["error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay exited with status ${this.status} at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayIncompleteError extends Schema.TaggedError<ClaudeReplayIncompleteError>()(
  "ClaudeReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayDriverError extends Schema.TaggedError<ClaudeReplayDriverError>()(
  "ClaudeReplayDriverError",
  {
    scenario: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay driver failed in scenario ${this.scenario}.`;
  }
}

export const ClaudeAgentSdkReplayError = Schema.Union([
  ClaudeReplayTranscriptDecodeError,
  ClaudeReplayExhaustedError,
  ClaudeReplayUnexpectedOutboundError,
  ClaudeReplayFrameMismatchError,
  ClaudeReplayRuntimeExitError,
  ClaudeReplayIncompleteError,
  ClaudeReplayDriverError,
]);
export type ClaudeAgentSdkReplayError = typeof ClaudeAgentSdkReplayError.Type;
export const ClaudeOrchestratorReplayHarnessError = Schema.Union([
  ClaudeAgentSdkReplayError,
  ProviderAdapterDriverCreateError,
]);
export type ClaudeOrchestratorReplayHarnessError = typeof ClaudeOrchestratorReplayHarnessError.Type;

export interface ClaudeQueryOpenFrame {
  readonly type: "query.open";
  readonly options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
}

export interface ClaudePromptOfferFrame {
  readonly type: "prompt.offer";
  readonly message: SDKUserMessage;
}

export interface ClaudeQuerySetModelFrame {
  readonly type: "query.set_model";
  readonly model: string;
}

export interface ClaudeQuerySetPermissionModeFrame {
  readonly type: "query.set_permission_mode";
  readonly mode: string;
}

export interface ClaudeQueryInterruptFrame {
  readonly type: "query.interrupt";
}

export interface ClaudePermissionRequestFrame {
  readonly type: "permission.request";
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly options: {
    readonly suggestions?: Parameters<CanUseTool>[2]["suggestions"];
    readonly blockedPath?: string;
    readonly decisionReason?: string;
    readonly title?: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly toolUseID: string;
    readonly agentID?: string;
  };
}

export interface ClaudePermissionResponseFrame {
  readonly type: "permission.response";
  readonly result: PermissionResult;
}

export interface ClaudeSessionForkFrame {
  readonly type: "session.fork";
  readonly sessionId: string;
  readonly options: {
    readonly dir?: string;
    readonly upToMessageId?: string;
    readonly title?: string;
  };
}

export interface ClaudeSessionForkedFrame {
  readonly type: "session.forked";
  readonly sessionId: string;
}

export interface ClaudeSubagentLookupFrame {
  readonly type: "subagent.lookup";
  readonly sessionId: string;
  readonly agentId: string;
}

export interface ClaudeSubagentFoundFrame {
  readonly type: "subagent.found";
  readonly toolUseId: string | null;
}

export type ClaudeOutboundFrame =
  | { readonly type: "query.stop_task"; readonly taskId: string }
  | { readonly type: "query.background_tasks"; readonly toolUseId: string }
  | ClaudeQueryOpenFrame
  | ClaudePromptOfferFrame
  | ClaudeQuerySetModelFrame
  | {
      readonly type: "query.apply_flag_settings";
      readonly settings: Parameters<
        ClaudeAdapterV2.ClaudeAgentSdkQuerySession["applyFlagSettings"]
      >[0];
    }
  | ClaudeQuerySetPermissionModeFrame
  | ClaudeQueryInterruptFrame
  | ClaudePermissionResponseFrame
  | ClaudeSessionForkFrame
  | ClaudeSubagentLookupFrame;

export interface ClaudeQueryRunner {
  readonly open: (
    input: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput,
  ) => ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
  readonly forkSession: (
    input: ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput,
  ) => ClaudeSessionForkedFrame;
  readonly subagentLaunchToolUseId: (
    input: ClaudeAdapterV2.ClaudeAgentSdkSubagentLookupInput,
  ) => string | null;
  readonly assertComplete: () => void;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeContextHandoffText(value: string): string {
  if (!value.startsWith("Context handoff (")) {
    return value;
  }
  const userMessageMarker = "\n\nUser message:\n";
  const userMessageIndex = value.indexOf(userMessageMarker);
  const headerEndIndex = value.indexOf(":\n");
  if (headerEndIndex === -1 || userMessageIndex === -1 || headerEndIndex >= userMessageIndex) {
    return value;
  }
  return `${value.slice(0, headerEndIndex + 2)}<dynamic-summary>${value.slice(userMessageIndex)}`;
}

export function normalizeReplayFrame(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeContextHandoffText(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeReplayFrame);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeReplayFrame(entry)]),
  );
}

export function sameFrame(left: unknown, right: unknown): boolean {
  return (
    stableStringify(normalizeReplayFrame(left)) === stableStringify(normalizeReplayFrame(right))
  );
}

export function isClaudeSdkReplayMessage(frame: unknown): frame is SDKMessage {
  if (typeof frame !== "object" || frame === null) {
    return false;
  }
  const type = Reflect.get(frame, "type");
  return (
    type === "assistant" ||
    type === "user" ||
    type === "result" ||
    type === "system" ||
    type === "stream_event" ||
    type === "rate_limit_event" ||
    // The SDK types omit command_lifecycle for prompt uuids.
    type === "command_lifecycle"
  );
}

export function sdkMessageFromReplayFrame(frame: unknown): SDKMessage {
  if (!isClaudeSdkReplayMessage(frame)) {
    throw new Error("Replay frame is not a Claude Agent SDK message.");
  }
  return frame;
}

export function isClaudePermissionRequestFrame(frame: unknown): frame is ClaudePermissionRequestFrame {
  const options =
    typeof frame === "object" && frame !== null ? Reflect.get(frame, "options") : undefined;
  return (
    typeof frame === "object" &&
    frame !== null &&
    Reflect.get(frame, "type") === "permission.request" &&
    typeof Reflect.get(frame, "toolName") === "string" &&
    typeof Reflect.get(frame, "input") === "object" &&
    Reflect.get(frame, "input") !== null &&
    typeof options === "object" &&
    options !== null &&
    typeof Reflect.get(options, "toolUseID") === "string"
  );
}

export function makeClaudePermissionResponseFrame(
  result: PermissionResult,
): ClaudePermissionResponseFrame {
  return {
    type: "permission.response",
    result,
  };
}

export function permissionRequestOptionsFromFrame(
  frame: ClaudePermissionRequestFrame,
  signal: AbortSignal,
): Parameters<CanUseTool>[2] {
  const options = frame.options;
  return {
    signal,
    ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
    ...(options.blockedPath === undefined ? {} : { blockedPath: options.blockedPath }),
    ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    ...(options.description === undefined ? {} : { description: options.description }),
    toolUseID: options.toolUseID,
    ...(options.agentID === undefined ? {} : { agentID: options.agentID }),
    requestId: options.toolUseID,
  };
}

export function unresolvedCursorSignal(): void {}

export function makeCursorSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = unresolvedCursorSignal;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

export function waitForCursorAdvance(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let waiting = true;
    const finish = () => {
      if (!waiting) {
        return;
      }
      waiting = false;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void promise.then(finish);
    if (signal.aborted) {
      finish();
    }
  });
}

export async function waitForReplayDelay(afterMs: number, signal: AbortSignal): Promise<void> {
  const exit = await Effect.runPromiseExit(Effect.sleep(Duration.millis(afterMs)), { signal });
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    throw Cause.squash(exit.cause);
  }
}

export function stableClaudeQueryOptions(
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
): ClaudeAdapterV2.ClaudeAgentSdkQueryOptions {
  const stable = {
    model: options.model,
    tools: options.tools,
    permissionMode: options.permissionMode,
    ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.allowDangerouslySkipPermissions === true
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(options.resumeSessionAt === undefined ? {} : { resumeSessionAt: options.resumeSessionAt }),
    ...(options.forkSession === true ? { forkSession: true } : {}),
  };
  return options.resume === undefined
    ? { ...stable, sessionId: options.sessionId }
    : { ...stable, resume: options.resume };
}

export function makeClaudeQueryOpenFrame(
  input: Pick<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput, "options">,
): ClaudeQueryOpenFrame {
  return {
    type: "query.open",
    options: stableClaudeQueryOptions(input.options),
  };
}

export function makeClaudePromptOfferFrame(message: SDKUserMessage): ClaudePromptOfferFrame {
  return {
    type: "prompt.offer",
    message,
  };
}

export function makeClaudeSessionForkFrame(
  input: ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput,
  scenario: string,
): ClaudeSessionForkFrame {
  return {
    type: "session.fork",
    sessionId: input.sessionId,
    options: {
      ...(input.options.dir === undefined ? {} : { dir: sanitizedReplayCwd(scenario) }),
      ...(input.options.upToMessageId === undefined
        ? {}
        : { upToMessageId: input.options.upToMessageId }),
      ...(input.options.title === undefined ? {} : { title: input.options.title }),
    },
  };
}
