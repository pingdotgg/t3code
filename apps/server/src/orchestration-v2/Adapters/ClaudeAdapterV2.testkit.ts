import path from "node:path";

import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderReplayEntry,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import { Effect, Layer, Random, Schema, Stream } from "effect";

import {
  CLAUDE_PROVIDER,
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerError,
  makeClaudeUserMessage,
  makeClaudeQueryOptions,
  type ClaudeAgentSdkQueryOpenInput,
  type ClaudeAgentSdkQueryOptions,
  type ClaudeAgentSdkQuerySession,
  type ClaudeAgentSdkQueryTools,
} from "./ClaudeAdapterV2.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { layerFromProviderAdapter } from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

export const CLAUDE_AGENT_SDK_REPLAY_PROTOCOL = "claude-agent-sdk.query" as const;

const ClaudeAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(CLAUDE_PROVIDER),
  protocol: Schema.Literal(CLAUDE_AGENT_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type ClaudeAgentSdkReplayTranscript = typeof ClaudeAgentSdkReplayTranscript.Type;

export class ClaudeReplayTranscriptDecodeError extends Schema.TaggedErrorClass<ClaudeReplayTranscriptDecodeError>()(
  "ClaudeReplayTranscriptDecodeError",
  {
    provider: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Failed to decode Claude Agent SDK replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export class ClaudeReplayExhaustedError extends Schema.TaggedErrorClass<ClaudeReplayExhaustedError>()(
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

export class ClaudeReplayUnexpectedOutboundError extends Schema.TaggedErrorClass<ClaudeReplayUnexpectedOutboundError>()(
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

export class ClaudeReplayFrameMismatchError extends Schema.TaggedErrorClass<ClaudeReplayFrameMismatchError>()(
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

export class ClaudeReplayRuntimeExitError extends Schema.TaggedErrorClass<ClaudeReplayRuntimeExitError>()(
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

export class ClaudeReplayIncompleteError extends Schema.TaggedErrorClass<ClaudeReplayIncompleteError>()(
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

export class ClaudeReplayDriverError extends Schema.TaggedErrorClass<ClaudeReplayDriverError>()(
  "ClaudeReplayDriverError",
  {
    scenario: Schema.String,
    cause: Schema.Defect,
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

interface ClaudeQueryOpenFrame {
  readonly type: "query.open";
  readonly options: ClaudeAgentSdkQueryOptions;
}

interface ClaudePromptOfferFrame {
  readonly type: "prompt.offer";
  readonly message: SDKUserMessage;
}

interface ClaudeQuerySetModelFrame {
  readonly type: "query.set_model";
  readonly model: string;
}

interface ClaudeQueryInterruptFrame {
  readonly type: "query.interrupt";
}

interface ClaudePermissionRequestFrame {
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

interface ClaudePermissionResponseFrame {
  readonly type: "permission.response";
  readonly result: PermissionResult;
}

type ClaudeOutboundFrame =
  | ClaudeQueryOpenFrame
  | ClaudePromptOfferFrame
  | ClaudeQuerySetModelFrame
  | ClaudeQueryInterruptFrame
  | ClaudePermissionResponseFrame;

interface ClaudeQueryRunner {
  readonly open: (input: ClaudeAgentSdkQueryOpenInput) => ClaudeAgentSdkQuerySession;
  readonly assertComplete: () => void;
}

function stableStringify(value: unknown): string {
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

function sameFrame(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isClaudeSdkReplayMessage(frame: unknown): frame is SDKMessage {
  return (
    typeof frame === "object" && frame !== null && typeof Reflect.get(frame, "type") === "string"
  );
}

function sdkMessageFromReplayFrame(frame: unknown): SDKMessage {
  if (!isClaudeSdkReplayMessage(frame)) {
    throw new Error("Replay frame is not a Claude Agent SDK message.");
  }
  return frame;
}

function isClaudePermissionRequestFrame(frame: unknown): frame is ClaudePermissionRequestFrame {
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

function makeClaudePermissionResponseFrame(
  result: PermissionResult,
): ClaudePermissionResponseFrame {
  return {
    type: "permission.response",
    result,
  };
}

function permissionRequestOptionsFromFrame(
  frame: ClaudePermissionRequestFrame,
): Parameters<CanUseTool>[2] {
  const abortController = new AbortController();
  const options = frame.options;
  return {
    signal: abortController.signal,
    ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
    ...(options.blockedPath === undefined ? {} : { blockedPath: options.blockedPath }),
    ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    ...(options.description === undefined ? {} : { description: options.description }),
    toolUseID: options.toolUseID,
    ...(options.agentID === undefined ? {} : { agentID: options.agentID }),
  };
}

function unresolvedCursorSignal(): void {}

function makeCursorSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = unresolvedCursorSignal;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function stableClaudeQueryOptions(options: ClaudeAgentSdkQueryOptions): ClaudeAgentSdkQueryOptions {
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
  };
  return options.resume === undefined
    ? { ...stable, sessionId: options.sessionId }
    : { ...stable, resume: options.resume };
}

function makeClaudeQueryOpenFrame(
  input: Pick<ClaudeAgentSdkQueryOpenInput, "options">,
): ClaudeQueryOpenFrame {
  return {
    type: "query.open",
    options: stableClaudeQueryOptions(input.options),
  };
}

function makeClaudePromptOfferFrame(message: SDKUserMessage): ClaudePromptOfferFrame {
  return {
    type: "prompt.offer",
    message,
  };
}

function makeReplayQueryRunner(transcript: ClaudeAgentSdkReplayTranscript): ClaudeQueryRunner {
  let cursor = 0;
  let failure: ClaudeAgentSdkReplayError | null = null;
  let cursorAdvanced = makeCursorSignal();
  let activeOptions: ClaudeAgentSdkQueryOptions | null = null;

  const fail = (error: ClaudeAgentSdkReplayError): never => {
    failure = error;
    throw error;
  };

  const advance = () => {
    cursor += 1;
    const signal = cursorAdvanced;
    cursorAdvanced = makeCursorSignal();
    signal.resolve();
  };

  async function* replayMessages(): AsyncGenerator<SDKMessage, void> {
    while (true) {
      if (failure !== null) {
        throw failure;
      }

      const entry = transcript.entries[cursor];
      if (entry === undefined) {
        return;
      }

      if (entry.type === "emit_inbound") {
        if (isClaudePermissionRequestFrame(entry.frame)) {
          const request = entry.frame;
          const invokeCanUseTool = activeOptions?.canUseTool;
          if (invokeCanUseTool === undefined) {
            const error = new ClaudeReplayUnexpectedOutboundError({
              scenario: transcript.scenario,
              cursor,
              expectedType: "permission.request",
              actual: request,
            });
            failure = error;
            throw error;
          }
          advance();
          const result = await invokeCanUseTool(
            request.toolName,
            request.input,
            permissionRequestOptionsFromFrame(request),
          );
          assertNextOutboundFrame(makeClaudePermissionResponseFrame(result));
          continue;
        }
        advance();
        yield sdkMessageFromReplayFrame(entry.frame);
        continue;
      }

      if (entry.type === "runtime_exit") {
        advance();
        if (entry.status === "success" || entry.status === "cancelled") {
          return;
        }
        fail(
          new ClaudeReplayRuntimeExitError({
            scenario: transcript.scenario,
            cursor: cursor - 1,
            status: entry.status,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          }),
        );
      }

      if (entry.type === "expect_outbound") {
        const signal = cursorAdvanced;
        await signal.promise;
        continue;
      }
    }
  }

  const assertNextOutboundFrame = (actual: ClaudeOutboundFrame) => {
    if (failure !== null) {
      throw failure;
    }
    const entry = transcript.entries[cursor];
    if (entry === undefined) {
      return fail(
        new ClaudeReplayExhaustedError({
          scenario: transcript.scenario,
          cursor,
          actual,
        }),
      );
    }
    if (entry.type !== "expect_outbound") {
      return fail(
        new ClaudeReplayUnexpectedOutboundError({
          scenario: transcript.scenario,
          cursor,
          expectedType: entry.type,
          actual,
        }),
      );
    }

    const expected = entry.frame;
    if (!sameFrame(expected, actual)) {
      fail(
        new ClaudeReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          expected,
          actual,
        }),
      );
    }

    advance();
  };

  const replayEffect = (tryEffect: () => void) =>
    Effect.try({
      try: tryEffect,
      catch: (cause) => replayQueryRunnerError(transcript, cause),
    });

  return {
    open: (input) => {
      assertNextOutboundFrame(makeClaudeQueryOpenFrame(input));
      activeOptions = input.options;
      return {
        messages: Stream.fromAsyncIterable(replayMessages(), (cause) =>
          replayQueryRunnerError(transcript, cause),
        ),
        offer: (message) =>
          replayEffect(() => {
            assertNextOutboundFrame(makeClaudePromptOfferFrame(message));
          }),
        setModel: (model) =>
          replayEffect(() => {
            assertNextOutboundFrame({
              type: "query.set_model",
              model,
            });
          }),
        interrupt: replayEffect(() => {
          assertNextOutboundFrame({ type: "query.interrupt" });
        }),
        close: Effect.void,
      };
    },
    assertComplete: () => {
      if (failure !== null) {
        throw failure;
      }
      if (cursor !== transcript.entries.length) {
        throw new ClaudeReplayIncompleteError({
          scenario: transcript.scenario,
          cursor,
          remaining: transcript.entries.length - cursor,
        });
      }
    },
  };
}

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

function nativeSessionIdFor(transcript: ClaudeAgentSdkReplayTranscript): string {
  const metadataSessionId = transcript.metadata?.nativeSessionId;
  return typeof metadataSessionId === "string"
    ? metadataSessionId
    : "00000000-0000-4000-8000-000000000000";
}

function replayQueryRunnerError(
  transcript: ClaudeAgentSdkReplayTranscript,
  cause: unknown,
): ClaudeAgentSdkQueryRunnerError {
  if (Schema.is(ClaudeAgentSdkQueryRunnerError)(cause)) {
    return cause;
  }
  const replayCause = Schema.is(ClaudeAgentSdkReplayError)(cause)
    ? cause
    : new ClaudeReplayDriverError({ scenario: transcript.scenario, cause });
  return new ClaudeAgentSdkQueryRunnerError({
    cause: replayCause,
    method: `replay-scenario:${transcript.scenario}`,
  });
}

const makeClaudeAgentSdkReplayQueryRunner = Effect.fn("ClaudeAgentSdkReplayQueryRunner.layer")(
  function* (transcript: ClaudeAgentSdkReplayTranscript) {
    const queryRunner = makeReplayQueryRunner(transcript);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        queryRunner.assertComplete();
      }),
    );

    return ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: Effect.succeed(nativeSessionIdFor(transcript)),
      open: (input) =>
        Effect.try({
          try: () => queryRunner.open(input),
          catch: (cause) => replayQueryRunnerError(transcript, cause),
        }),
      assertComplete: Effect.try({
        try: () => queryRunner.assertComplete(),
        catch: (cause) => replayQueryRunnerError(transcript, cause),
      }),
    });
  },
);

export function makeClaudeAgentSdkReplayQueryRunnerLayer(
  transcript: ClaudeAgentSdkReplayTranscript,
): Layer.Layer<ClaudeAgentSdkQueryRunner> {
  return Layer.effect(ClaudeAgentSdkQueryRunner, makeClaudeAgentSdkReplayQueryRunner(transcript));
}

export function makeClaudeProviderAdapterRegistryReplayLayer(
  transcript: ClaudeAgentSdkReplayTranscript,
) {
  const adapterLayer = claudeAdapterLayer.pipe(
    Layer.provide(makeClaudeAgentSdkReplayQueryRunnerLayer(transcript)),
    Layer.provide(idAllocatorLayer),
  );
  return layerFromProviderAdapter.pipe(Layer.provide(adapterLayer));
}

export async function replayClaudeAgentSdkTranscript(input: {
  readonly transcript: ClaudeAgentSdkReplayTranscript;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd?: string;
}): Promise<ReadonlyArray<SDKMessage>> {
  return input.transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && !isClaudePermissionRequestFrame(entry.frame)
      ? [sdkMessageFromReplayFrame(entry.frame)]
      : [],
  );
}

function serializeReplayError(error: unknown, scenario?: string): unknown {
  return error instanceof Error
    ? {
        name: error.name,
        message:
          scenario === undefined
            ? error.message
            : sanitizeReplayText({ text: error.message, scenario }),
      }
    : error;
}

function permissionResultForRecording(input: {
  readonly decision: ProviderApprovalDecision;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseID: string;
  readonly suggestions?: Parameters<CanUseTool>[2]["suggestions"];
}): PermissionResult {
  if (input.decision === "accept" || input.decision === "acceptForSession") {
    return {
      behavior: "allow",
      updatedInput: input.toolInput,
      toolUseID: input.toolUseID,
      decisionClassification:
        input.decision === "acceptForSession" ? "user_permanent" : "user_temporary",
      ...(input.decision === "acceptForSession" && input.suggestions !== undefined
        ? { updatedPermissions: input.suggestions }
        : {}),
    };
  }
  return {
    behavior: "deny",
    message:
      input.decision === "cancel"
        ? "User cancelled tool execution."
        : "User declined tool execution.",
    toolUseID: input.toolUseID,
    decisionClassification: "user_reject",
    ...(input.decision === "cancel" ? { interrupt: true } : {}),
  };
}

function permissionRequestFrame(input: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly callbackOptions: Parameters<CanUseTool>[2];
}): ClaudePermissionRequestFrame {
  const { callbackOptions } = input;
  return {
    type: "permission.request",
    toolName: input.toolName,
    input: input.toolInput,
    options: {
      ...(callbackOptions.suggestions === undefined
        ? {}
        : { suggestions: callbackOptions.suggestions }),
      ...(callbackOptions.blockedPath === undefined
        ? {}
        : { blockedPath: callbackOptions.blockedPath }),
      ...(callbackOptions.decisionReason === undefined
        ? {}
        : { decisionReason: callbackOptions.decisionReason }),
      ...(callbackOptions.title === undefined ? {} : { title: callbackOptions.title }),
      ...(callbackOptions.displayName === undefined
        ? {}
        : { displayName: callbackOptions.displayName }),
      ...(callbackOptions.description === undefined
        ? {}
        : { description: callbackOptions.description }),
      toolUseID: callbackOptions.toolUseID,
      ...(callbackOptions.agentID === undefined ? {} : { agentID: callbackOptions.agentID }),
    },
  };
}

function sanitizedReplayCwd(scenario: string): string {
  return `/tmp/claude-replay-${scenario}`;
}

function sanitizeReplayText(input: { readonly text: string; readonly scenario: string }): string {
  const sanitizedCwd = sanitizedReplayCwd(input.scenario);
  return [path.resolve(process.cwd(), "../.."), process.cwd()]
    .toSorted((left, right) => right.length - left.length)
    .reduce((text, localPath) => text.replaceAll(localPath, sanitizedCwd), input.text);
}

function sanitizeSdkMessageForReplay(input: {
  readonly message: SDKMessage;
  readonly scenario: string;
}): SDKMessage {
  const { message } = input;
  if (message.type === "system" && message.subtype === "init") {
    return {
      type: "system",
      subtype: "init",
      ...(message.agents === undefined ? {} : { agents: [] }),
      apiKeySource: message.apiKeySource,
      ...(message.betas === undefined ? {} : { betas: message.betas }),
      claude_code_version: message.claude_code_version,
      cwd: sanitizedReplayCwd(input.scenario),
      tools: [],
      mcp_servers: [],
      model: message.model,
      permissionMode: message.permissionMode,
      slash_commands: [],
      output_style: message.output_style,
      skills: [],
      plugins: [],
      ...(message.fast_mode_state === undefined
        ? {}
        : { fast_mode_state: message.fast_mode_state }),
      uuid: message.uuid,
      session_id: message.session_id,
    };
  }
  if (message.type === "rate_limit_event") {
    return {
      ...message,
      rate_limit_info: {
        status: message.rate_limit_info.status,
      },
    };
  }
  if (message.type === "result" && message.subtype !== "success" && message.errors.length > 0) {
    return {
      ...message,
      errors: message.errors.map((error) =>
        sanitizeReplayText({ text: error, scenario: input.scenario }),
      ),
    };
  }
  return message;
}

class RecordingPromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: Array<IteratorResult<SDKUserMessage>> = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  offer(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error("Cannot offer a prompt to a closed Claude recording queue.");
    }
    this.push({ done: false, value: message });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.push({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = await this.take();
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }

  private push(result: IteratorResult<SDKUserMessage>): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.pending.push(result);
      return;
    }
    waiter(result);
  }

  private take(): Promise<IteratorResult<SDKUserMessage>> {
    const next = this.pending.shift();
    if (next !== undefined) {
      return Promise.resolve(next);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

async function recordMessagesUntilTurnResult(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
}): Promise<boolean> {
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      return false;
    }
    const replayMessage = sanitizeSdkMessageForReplay({
      message: next.value,
      scenario: input.scenario,
    });
    input.entries.push({
      type: "emit_inbound",
      label: replayMessage.type,
      frame: replayMessage,
    });
    if (replayMessage.type === "result") {
      return true;
    }
  }
}

async function recordMessagesUntilTurnResults(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
  readonly resultCount: number;
}): Promise<boolean> {
  let seenResults = 0;
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      return false;
    }
    const replayMessage = sanitizeSdkMessageForReplay({
      message: next.value,
      scenario: input.scenario,
    });
    input.entries.push({
      type: "emit_inbound",
      label: replayMessage.type,
      frame: replayMessage,
    });
    if (replayMessage.type === "result") {
      seenResults += 1;
      if (seenResults >= input.resultCount) {
        return true;
      }
    }
  }
}

async function recordMessagesUntilIteratorDone(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
}): Promise<void> {
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      return;
    }
    const replayMessage = sanitizeSdkMessageForReplay({
      message: next.value,
      scenario: input.scenario,
    });
    input.entries.push({
      type: "emit_inbound",
      label: replayMessage.type,
      frame: replayMessage,
    });
  }
}

function sdkMessageHasToolUse(message: SDKMessage): boolean {
  return (
    message.type === "assistant" && message.message.content.some((part) => part.type === "tool_use")
  );
}

async function recordMessagesUntilFirstToolUse(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
}): Promise<void> {
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      throw new Error(`Claude query ended before ${input.scenario} started a tool use.`);
    }
    const replayMessage = sanitizeSdkMessageForReplay({
      message: next.value,
      scenario: input.scenario,
    });
    input.entries.push({
      type: "emit_inbound",
      label: replayMessage.type,
      frame: replayMessage,
    });
    if (replayMessage.type === "result") {
      throw new Error(`Claude query completed before ${input.scenario} started a tool use.`);
    }
    if (sdkMessageHasToolUse(replayMessage)) {
      return;
    }
  }
}

async function recordClaudeStreamingQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
}): Promise<void> {
  const promptQueue = new RecordingPromptQueue();
  const canUseTool: CanUseTool | undefined =
    input.enablePermissionCallback === true
      ? async (toolName, toolInput, callbackOptions) => {
          const requestFrame = permissionRequestFrame({
            toolName,
            toolInput,
            callbackOptions,
          });
          input.entries.push({
            type: "emit_inbound",
            label: `permission.request:${toolName}`,
            frame: requestFrame,
          });
          const result = permissionResultForRecording({
            decision: input.permissionDecision ?? "accept",
            toolInput,
            toolUseID: callbackOptions.toolUseID,
            ...(callbackOptions.suggestions === undefined
              ? {}
              : { suggestions: callbackOptions.suggestions }),
          });
          input.entries.push({
            type: "expect_outbound",
            label: `permission.response:${toolName}`,
            frame: makeClaudePermissionResponseFrame(result),
          });
          return result;
        }
      : undefined;
  const options = makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: false,
    cwd: input.cwd,
    ...(input.enableTools === true
      ? {
          tools: input.tools ?? { type: "preset", preset: "claude_code" },
          permissionMode: input.permissionMode ?? "default",
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          ...(input.disallowedTools === undefined
            ? {}
            : { disallowedTools: input.disallowedTools }),
          ...(input.allowDangerouslySkipPermissions === true
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(canUseTool === undefined ? {} : { canUseTool }),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open",
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const queryRuntime = query({
    prompt: promptQueue,
    options,
  });
  const iterator = queryRuntime[Symbol.asyncIterator]();
  try {
    for (const [index, prompt] of input.prompts.entries()) {
      const message = makeClaudeUserMessage({ text: prompt });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      promptQueue.offer(message);
      const completed = await recordMessagesUntilTurnResult({
        iterator,
        entries: input.entries,
        scenario: input.scenario,
      });
      if (!completed) {
        throw new Error(`Claude streaming query ended before prompt ${index + 1} completed.`);
      }
    }
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

async function recordClaudeActiveSteeringQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
}): Promise<void> {
  if (input.prompts.length < 2) {
    throw new Error("Claude active steering replay recording requires at least two prompts.");
  }

  const promptQueue = new RecordingPromptQueue();
  const offeredPrompts = new Set<number>();
  const offerPrompt = (index: number, priority?: SDKUserMessage["priority"]) => {
    const message = makeClaudeUserMessage({
      text: input.prompts[index]!,
      ...(priority === undefined ? {} : { priority }),
    });
    input.entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: makeClaudePromptOfferFrame(message),
    });
    promptQueue.offer(message);
    offeredPrompts.add(index);
  };
  const offerSteeringPrompts = () => {
    for (let index = 1; index < input.prompts.length; index += 1) {
      if (!offeredPrompts.has(index)) {
        offerPrompt(index, "now");
      }
    }
  };

  const canUseTool: CanUseTool | undefined =
    input.enablePermissionCallback === true
      ? async (toolName, toolInput, callbackOptions) => {
          const requestFrame = permissionRequestFrame({
            toolName,
            toolInput,
            callbackOptions,
          });
          input.entries.push({
            type: "emit_inbound",
            label: `permission.request:${toolName}`,
            frame: requestFrame,
          });
          const result = permissionResultForRecording({
            decision: input.permissionDecision ?? "accept",
            toolInput,
            toolUseID: callbackOptions.toolUseID,
            ...(callbackOptions.suggestions === undefined
              ? {}
              : { suggestions: callbackOptions.suggestions }),
          });
          input.entries.push({
            type: "expect_outbound",
            label: `permission.response:${toolName}`,
            frame: makeClaudePermissionResponseFrame(result),
          });
          return result;
        }
      : undefined;
  const options = makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: false,
    cwd: input.cwd,
    ...(input.enableTools === true
      ? {
          tools: input.tools ?? { type: "preset", preset: "claude_code" },
          permissionMode: input.permissionMode ?? "default",
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          ...(input.disallowedTools === undefined
            ? {}
            : { disallowedTools: input.disallowedTools }),
          ...(input.allowDangerouslySkipPermissions === true
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(canUseTool === undefined ? {} : { canUseTool }),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open",
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const queryRuntime = query({
    prompt: promptQueue,
    options,
  });
  const iterator = queryRuntime[Symbol.asyncIterator]();
  try {
    offerPrompt(0);
    offerSteeringPrompts();
    const completed = await recordMessagesUntilTurnResults({
      iterator,
      entries: input.entries,
      scenario: input.scenario,
      resultCount: input.prompts.length,
    });
    if (!completed) {
      throw new Error("Claude active steering query ended before the turn completed.");
    }
    if (offeredPrompts.size < input.prompts.length) {
      throw new Error("Claude active steering prompts were not all offered before completion.");
    }
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

async function recordClaudeRestartingQueries(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  for (const [index, prompt] of input.prompts.entries()) {
    const promptQueue = new RecordingPromptQueue();
    const options = makeClaudeQueryOptions({
      modelSelection: input.modelSelection,
      nativeThreadId: input.sessionId,
      resume: index > 0,
      cwd: input.cwd,
      ...(input.enableTools === true
        ? {
            tools: input.tools ?? { type: "preset", preset: "claude_code" },
            permissionMode: input.permissionMode ?? "default",
            ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
            ...(input.disallowedTools === undefined
              ? {}
              : { disallowedTools: input.disallowedTools }),
            ...(input.allowDangerouslySkipPermissions === true
              ? { allowDangerouslySkipPermissions: true }
              : {}),
          }
        : {}),
    });

    input.entries.push({
      type: "expect_outbound",
      label: `query.open:${index + 1}`,
      frame: makeClaudeQueryOpenFrame({ options }),
    });
    const message = makeClaudeUserMessage({ text: prompt });
    input.entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: makeClaudePromptOfferFrame(message),
    });

    try {
      const queryRuntime = query({
        prompt: promptQueue,
        options,
      });
      promptQueue.offer(message);
      promptQueue.close();
      const iterator = queryRuntime[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        const replayMessage = sanitizeSdkMessageForReplay({
          message: next.value,
          scenario: input.scenario,
        });
        input.entries.push({
          type: "emit_inbound",
          label: replayMessage.type,
          frame: replayMessage,
        });
      }
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
    } catch (error) {
      promptQueue.close();
      input.entries.push({
        type: "runtime_exit",
        status: "error",
        error: serializeReplayError(error, input.scenario),
      });
      throw error;
    }
  }
}

async function recordInterruptedClaudeQuery(input: {
  readonly scenario: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly resume: boolean;
  readonly entries: Array<ProviderReplayEntry>;
  readonly queryOpenLabel: string;
  readonly promptOfferLabel: string;
  readonly interruptLabel: string;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  const promptQueue = new RecordingPromptQueue();
  const options = makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: input.resume,
    cwd: input.cwd,
    ...(input.enableTools === true
      ? {
          tools: input.tools ?? { type: "preset", preset: "claude_code" },
          permissionMode: input.permissionMode ?? "default",
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          ...(input.disallowedTools === undefined
            ? {}
            : { disallowedTools: input.disallowedTools }),
          ...(input.allowDangerouslySkipPermissions === true
            ? { allowDangerouslySkipPermissions: true }
            : {}),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: input.queryOpenLabel,
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const runtime = query({
    prompt: promptQueue,
    options,
  });
  const iterator = runtime[Symbol.asyncIterator]();
  const message = makeClaudeUserMessage({ text: input.prompt });
  input.entries.push({
    type: "expect_outbound",
    label: input.promptOfferLabel,
    frame: makeClaudePromptOfferFrame(message),
  });
  promptQueue.offer(message);
  if (input.interruptAfter === "tool_use") {
    await recordMessagesUntilFirstToolUse({
      iterator,
      entries: input.entries,
      scenario: input.scenario,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  input.entries.push({
    type: "expect_outbound",
    label: input.interruptLabel,
    frame: { type: "query.interrupt" },
  });

  try {
    let cancelledError: unknown;
    try {
      await runtime.interrupt();
    } catch (error) {
      cancelledError = error;
    }
    promptQueue.close();
    runtime.close();
    try {
      await recordMessagesUntilIteratorDone({
        iterator,
        entries: input.entries,
        scenario: input.scenario,
      });
    } catch (error) {
      cancelledError = error;
    }
    input.entries.push({
      type: "runtime_exit",
      status: cancelledError === undefined ? "success" : "cancelled",
      ...(cancelledError === undefined
        ? {}
        : { error: serializeReplayError(cancelledError, input.scenario) }),
    });
  } catch (error) {
    promptQueue.close();
    runtime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

async function recordClaudeInterruptQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
}): Promise<void> {
  if (input.prompts.length !== 1) {
    throw new Error(
      `Claude interrupt replay scenario ${input.scenario} requires exactly one prompt.`,
    );
  }

  await recordInterruptedClaudeQuery({
    scenario: input.scenario,
    prompt: input.prompts[0]!,
    modelSelection: input.modelSelection,
    cwd: input.cwd,
    sessionId: input.sessionId,
    resume: false,
    entries: input.entries,
    queryOpenLabel: "query.open",
    promptOfferLabel: "prompt.offer:1",
    interruptLabel: "query.interrupt:1",
    ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
    ...(input.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
  });
}

async function recordClaudeInterruptRestartQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
}): Promise<void> {
  if (input.prompts.length !== 2) {
    throw new Error(
      `Claude interrupt-restart replay scenario ${input.scenario} requires exactly two prompts.`,
    );
  }

  await recordInterruptedClaudeQuery({
    scenario: input.scenario,
    prompt: input.prompts[0]!,
    modelSelection: input.modelSelection,
    cwd: input.cwd,
    sessionId: input.sessionId,
    resume: false,
    entries: input.entries,
    queryOpenLabel: "query.open:1",
    promptOfferLabel: "prompt.offer:1",
    interruptLabel: "query.interrupt:1",
    ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
    ...(input.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
  });

  const secondPromptQueue = new RecordingPromptQueue();
  const secondOptions = makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: true,
    cwd: input.cwd,
    ...(input.enableTools === true
      ? {
          tools: input.tools ?? { type: "preset", preset: "claude_code" },
          permissionMode: input.permissionMode ?? "default",
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          ...(input.disallowedTools === undefined
            ? {}
            : { disallowedTools: input.disallowedTools }),
          ...(input.allowDangerouslySkipPermissions === true
            ? { allowDangerouslySkipPermissions: true }
            : {}),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open:2",
    frame: makeClaudeQueryOpenFrame({ options: secondOptions }),
  });
  const secondMessage = makeClaudeUserMessage({ text: input.prompts[1]! });
  input.entries.push({
    type: "expect_outbound",
    label: "prompt.offer:2",
    frame: makeClaudePromptOfferFrame(secondMessage),
  });

  try {
    const secondRuntime = query({
      prompt: secondPromptQueue,
      options: secondOptions,
    });
    secondPromptQueue.offer(secondMessage);
    secondPromptQueue.close();
    const secondIterator = secondRuntime[Symbol.asyncIterator]();
    await recordMessagesUntilIteratorDone({
      iterator: secondIterator,
      entries: input.entries,
      scenario: input.scenario,
    });
    secondRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    secondPromptQueue.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

export async function recordClaudeAgentSdkReplayTranscript(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly queryMode?:
    | "streaming"
    | "restart"
    | "active_steering"
    | "interrupt"
    | "interrupt_restart";
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
}): Promise<ClaudeAgentSdkReplayTranscript> {
  if (input.prompts.length === 0) {
    throw new Error(
      `Claude Agent SDK replay scenario ${input.scenario} needs at least one prompt.`,
    );
  }

  const entries: Array<ProviderReplayEntry> = [];
  const sessionId = input.sessionId ?? (await Effect.runPromise(Random.nextUUIDv4));
  const queryMode = input.queryMode ?? "streaming";
  if (queryMode === "streaming") {
    await recordClaudeStreamingQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
    });
  } else if (queryMode === "active_steering") {
    await recordClaudeActiveSteeringQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
    });
  } else if (queryMode === "restart") {
    await recordClaudeRestartingQueries({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
    });
  } else if (queryMode === "interrupt") {
    await recordClaudeInterruptQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    });
  } else {
    await recordClaudeInterruptRestartQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    });
  }

  return {
    provider: CLAUDE_PROVIDER,
    protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
    version: "0.2.111",
    scenario: input.scenario,
    metadata: {
      prompts: [...input.prompts],
      model: input.modelSelection.model,
      nativeSessionId: sessionId,
      queryMode,
      tools: input.enableTools === true ? (input.tools ?? "claude_code") : "none",
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
      generatedBy: "recordClaudeAgentSdkReplayTranscript",
    },
    entries,
  };
}

export const ClaudeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  ClaudeAgentSdkReplayTranscript,
  ClaudeAgentSdkReplayError
> = {
  provider: CLAUDE_PROVIDER,
  decodeTranscript: (transcript) =>
    Schema.decodeUnknownEffect(ClaudeAgentSdkReplayTranscript)(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    makeClaudeProviderAdapterRegistryReplayLayer(transcript),
};
