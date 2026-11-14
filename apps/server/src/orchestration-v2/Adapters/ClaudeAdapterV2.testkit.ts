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
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
  ClaudeAgentSdkReplayError,
  ClaudeAgentSdkReplayTranscript,
  ClaudeOrchestratorReplayHarnessError,
  type ClaudePermissionRequestFrame,
  type ClaudeQueryRunner,
  ClaudeReplayDriverError,
  ClaudeReplayTranscriptDecodeError,
  DEFAULT_CLAUDE_SETTINGS,
  claudeBackgroundWakeResultLabel,
  makeClaudePermissionResponseFrame,
  makeClaudePromptOfferFrame,
  makeClaudeQueryOpenFrame,
  makeReplayQueryRunner,
} from "./ClaudeAdapterV2-part2.testkit.ts";
export * from "./ClaudeAdapterV2-part2.testkit.ts";

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

const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError);
const isClaudeAgentSdkReplayError = Schema.is(ClaudeAgentSdkReplayError);

export function replayQueryRunnerError(
  transcript: ClaudeAgentSdkReplayTranscript,
  cause: unknown,
): ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError {
  if (isClaudeAgentSdkQueryRunnerError(cause)) {
    return cause;
  }
  const replayCause = isClaudeAgentSdkReplayError(cause)
    ? cause
    : new ClaudeReplayDriverError({ scenario: transcript.scenario, cause });
  return new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
    cause: replayCause,
    method: `replay-scenario:${transcript.scenario}`,
  });
}

function replayQueryRunnerService(
  transcript: ClaudeAgentSdkReplayTranscript,
  queryRunner: ClaudeQueryRunner,
): ClaudeAdapterV2.ClaudeAgentSdkQueryRunner["Service"] {
  const replay = <A>(run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) => replayQueryRunnerError(transcript, cause),
    });
  return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
    allocateSessionId: Effect.succeed(nativeSessionIdFor(transcript)),
    open: (input) => replay(() => queryRunner.open(input)),
    forkSession: (input) => replay(() => queryRunner.forkSession(input)),
    subagentLaunchToolUseId: (input) => replay(() => queryRunner.subagentLaunchToolUseId(input)),
    assertComplete: replay(() => queryRunner.assertComplete()),
  });
}

function layerClaudeAgentSdkReplay(
  transcript: ClaudeAgentSdkReplayTranscript,
  options: {
    readonly replayGate?: ProviderReplayGate;
    readonly queryRunner?: ClaudeQueryRunner;
  } = {},
): Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner> {
  if (options.queryRunner !== undefined) {
    return Layer.succeed(
      ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
      replayQueryRunnerService(transcript, options.queryRunner),
    );
  }
  const queryRunner = makeReplayQueryRunner(transcript, options);
  return Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          queryRunner.assertComplete();
        }),
      );
      return replayQueryRunnerService(transcript, queryRunner);
    }),
  );
}

/** Replays write recorded Bash output to task_started files under a scenario-owned CLAUDE_CODE_TMPDIR. */
const writeReplayTaskOutputFiles = Effect.fn("ClaudeReplay.writeTaskOutputFiles")(function* (
  transcript: ClaudeAgentSdkReplayTranscript,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmpRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-replay-tasks-" });
  const frames = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && typeof entry.frame === "object" && entry.frame !== null
      ? [entry.frame as Record<string, unknown>]
      : [],
  );
  const outputByToolUseId = new Map<string, string>();
  for (const frame of frames) {
    const result = frame.tool_use_result as Record<string, unknown> | undefined;
    const content = (frame.message as { readonly content?: unknown } | undefined)?.content;
    if (typeof result?.stdout !== "string" || !Array.isArray(content)) continue;
    const toolResult = content.find(
      (block): block is { readonly tool_use_id: string } =>
        block?.type === "tool_result" && typeof block.tool_use_id === "string",
    );
    if (toolResult === undefined) continue;
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    outputByToolUseId.set(toolResult.tool_use_id, `${result.stdout}${stderr}`);
  }
  const root = claudeTaskOutputRoot(
    { CLAUDE_CODE_TMPDIR: tmpRoot },
    path,
    null,
    yield* HostProcess.Platform,
  );
  for (const frame of frames) {
    if (frame.type !== "system" || frame.subtype !== "task_started") continue;
    if (frame.task_type !== "local_bash" || frame.is_backgrounded !== false) continue;
    const output =
      typeof frame.tool_use_id === "string" ? outputByToolUseId.get(frame.tool_use_id) : undefined;
    if (root === undefined || output === undefined || typeof frame.session_id !== "string") {
      continue;
    }
    const tasks = path.join(root, "replay-project", frame.session_id, "tasks");
    yield* fileSystem.makeDirectory(tasks, { recursive: true });
    yield* fileSystem.writeFileString(path.join(tasks, `${String(frame.task_id)}.output`), output);
  }
  return tmpRoot;
});

function layerClaudeProviderAdapterRegistryReplay(
  transcript: ClaudeAgentSdkReplayTranscript,
  options: {
    readonly replayGate?: ProviderReplayGate;
    readonly queryRunner?: ClaudeQueryRunner;
  } = {},
) {
  const layerServerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  return Layer.unwrap(
    writeReplayTaskOutputFiles(transcript).pipe(
      Effect.orDie,
      Effect.map((tmpRoot) =>
        ProviderAdapterRegistry.layerFromAdaptersEffect(
          ClaudeAdapterV2.createClaudeAdapterV2(
            {
              instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
              displayName: undefined,
              environment: [{ name: "CLAUDE_CODE_TMPDIR", value: tmpRoot, sensitive: false }],
              enabled: true,
              config: DEFAULT_CLAUDE_SETTINGS,
            },
            {},
          ).pipe(Effect.map((adapter) => [adapter])),
        ),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerClaudeAgentSdkReplay(transcript, options),
        IdAllocator.layer,
        NodeServices.layer,
        NodeCrypto.layer,
        layerServerConfig,
      ),
    ),
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

export function sanitizedReplayCwd(scenario: string): string {
  return `/tmp/claude-replay-${scenario}`;
}

function parentDirectory(input: string): string {
  const trimmed = input.replace(/\/+$/u, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }
  return trimmed.slice(0, lastSlash);
}

function sanitizeReplayText(input: { readonly text: string; readonly scenario: string }): string {
  const sanitizedCwd = sanitizedReplayCwd(input.scenario);
  const repoRoot = parentDirectory(parentDirectory(process.cwd()));
  return [repoRoot, process.cwd()]
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
  // Recorded commands and skills are account configuration.
  if (message.type === "system" && message.subtype === "commands_changed") {
    return { ...message, commands: [] };
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

class RecordingMessageReader implements AsyncIterator<SDKMessage> {
  private pending: Promise<IteratorResult<SDKMessage>> | undefined;
  private readonly iterator: AsyncIterator<SDKMessage>;

  constructor(iterator: AsyncIterator<SDKMessage>) {
    this.iterator = iterator;
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const pending = this.pending ?? this.iterator.next();
    this.pending = undefined;
    return pending;
  }

  async peekWithin(ms: number): Promise<SDKMessage | undefined> {
    const pending = this.pending ?? this.iterator.next();
    this.pending = pending;
    return Promise.race([
      pending.then(
        (result) => (result.done === true ? undefined : result.value),
        () => undefined,
      ),
      Effect.runPromise(Effect.sleep(Duration.millis(ms))).then(() => undefined),
    ]);
  }
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

async function recordMessagesUntilTurnResultAndFinalize(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
  readonly finalize: () => void;
}): Promise<boolean> {
  try {
    return await recordMessagesUntilTurnResult(input);
  } finally {
    input.finalize();
  }
}

async function recordMessagesUntilTurnResultWithCursor(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
}): Promise<{
  readonly completed: boolean;
  readonly assistantMessageUuid: SDKAssistantMessage["uuid"] | null;
}> {
  let assistantMessageUuid: SDKAssistantMessage["uuid"] | null = null;
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      return { completed: false, assistantMessageUuid };
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
    if (replayMessage.type === "assistant") {
      assistantMessageUuid = replayMessage.uuid;
    }
    if (replayMessage.type === "result") {
      return { completed: true, assistantMessageUuid };
    }
  }
}

function requireAssistantCursor(input: {
  readonly scenario: string;
  readonly promptIndex: number;
  readonly cursor: SDKAssistantMessage["uuid"] | null;
}): SDKAssistantMessage["uuid"] {
  if (input.cursor !== null) {
    return input.cursor;
  }
  throw new Error(
    `Claude replay scenario ${input.scenario} prompt ${input.promptIndex} completed without an SDKAssistantMessage.uuid cursor.`,
  );
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

const CLAUDE_RECORDING_WAKE_QUIET_MS = 5_000;

function isSystemInitFrame(message: SDKMessage | undefined): boolean {
  return message?.type === "system" && message.subtype === "init";
}

function isTaskNotificationOriginResultFrame(frame: unknown): boolean {
  if (typeof frame !== "object" || frame === null || Reflect.get(frame, "type") !== "result") {
    return false;
  }
  const origin: unknown = Reflect.get(frame, "origin");
  return (
    typeof origin === "object" &&
    origin !== null &&
    Reflect.get(origin, "kind") === "task-notification"
  );
}

function sdkMessageHasRootToolUse(message: SDKMessage): boolean {
  return (
    message.type === "assistant" &&
    message.parent_tool_use_id === null &&
    message.message.content.some((part) => part.type === "tool_use")
  );
}

async function recordMessagesUntilToolUse(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
  readonly toolUseCount: number;
}): Promise<void> {
  let toolUses = 0;
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
    if (sdkMessageHasRootToolUse(replayMessage)) {
      toolUses += 1;
      if (toolUses >= input.toolUseCount) {
        return;
      }
    }
  }
}

// The SDK may lack a platform executable. Prefer installed Claude only when directly spawnable,
// including Windows shims resolved to package entries.
const resolveClaudeRecordingExecutablePath = Effect.fn("resolveClaudeRecordingExecutablePath")(
  function* (environment: NodeJS.ProcessEnv) {
    const resolveExecutable = yield* SpawnExecutableResolution;
    const platform = yield* HostProcess.Platform;
    const resolved = resolveExecutable("claude", platform, environment);
    if (resolved === undefined) {
      return undefined;
    }
    const executablePath = yield* resolveClaudeSdkExecutablePath(resolved, environment);
    if (platform === "win32" && isWindowsClaudeLauncherShimPath(executablePath)) {
      return undefined;
    }
    return executablePath;
  },
);

async function openRecordingQuery(input: Parameters<typeof query>[0]) {
  const executablePath = await Effect.runPromise(resolveClaudeRecordingExecutablePath(process.env));
  return query({
    ...input,
    options: {
      ...input.options,
      ...(executablePath === undefined ? {} : { pathToClaudeCodeExecutable: executablePath }),
    },
  });
}

async function recordClaudeStreamingQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
  readonly backgroundWakeCounts?: ReadonlyArray<number>;
  readonly offerNextPromptImmediately?: boolean;
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
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
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
  const queryRuntime = await openRecordingQuery({
    prompt: promptQueue,
    options,
  });
  const iterator = new RecordingMessageReader(queryRuntime[Symbol.asyncIterator]());
  let wakeNumber = 0;
  const recordTurn = async (promptNumber: number): Promise<"prompt" | "wake"> => {
    const completed = await recordMessagesUntilTurnResult({
      iterator,
      entries: input.entries,
      scenario: input.scenario,
    });
    if (!completed) {
      throw new Error(
        `Claude streaming query ended before prompt ${promptNumber} and its background wakes completed.`,
      );
    }
    const resultEntry = input.entries.at(-1);
    const resultFrame = resultEntry?.type === "emit_inbound" ? resultEntry.frame : undefined;
    if (!isTaskNotificationOriginResultFrame(resultFrame)) {
      return "prompt";
    }
    wakeNumber += 1;
    input.entries[input.entries.length - 1] = {
      type: "emit_inbound",
      label: claudeBackgroundWakeResultLabel(wakeNumber),
      frame: resultFrame,
    };
    return "wake";
  };
  try {
    for (const [index, prompt] of input.prompts.entries()) {
      const message = ClaudeAdapterV2.makeClaudeUserMessage({
        text: prompt,
        uuid: await Effect.runPromise(
          SecureRandom.SecureRandom.pipe(
            Effect.flatMap((random) => random.uuidV4()),
            Effect.filterOrFail(ClaudeAdapterV2.isClaudePromptUuid),
            Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      promptQueue.offer(message);
      // Wake turns can precede the prompt turn; identify results by origin.
      let promptSettled = false;
      let wakes = 0;
      const expectedWakes = input.backgroundWakeCounts?.[index] ?? 0;
      while (!promptSettled || wakes < expectedWakes) {
        if ((await recordTurn(index + 1)) === "prompt") {
          promptSettled = true;
        } else {
          wakes += 1;
        }
      }
      if (input.backgroundWakeCounts !== undefined && input.offerNextPromptImmediately !== true) {
        // system:init opens each turn; leave ongoing subagent frames for the next recording.
        while (isSystemInitFrame(await iterator.peekWithin(CLAUDE_RECORDING_WAKE_QUIET_MS))) {
          await recordTurn(index + 1);
        }
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
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
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
  const offerPrompt = (index: number, priority?: SDKUserMessage["priority"]) => {
    const message = ClaudeAdapterV2.makeClaudeUserMessage({
      text: input.prompts[index]!,
      ...(priority === undefined ? {} : { priority }),
    });
    input.entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: makeClaudePromptOfferFrame(message),
    });
    promptQueue.offer(message);
  };
  const offerSteeringPrompts = () => {
    for (let index = 1; index < input.prompts.length; index += 1) {
      offerPrompt(index, "now");
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
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
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
  const queryRuntime = await openRecordingQuery({
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
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  for (const [index, prompt] of input.prompts.entries()) {
    const promptQueue = new RecordingPromptQueue();
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
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
    const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
    input.entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: makeClaudePromptOfferFrame(message),
    });

    try {
      const queryRuntime = await openRecordingQuery({
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

async function recordClaudeResumeAtCursorQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly metadata: Record<string, unknown>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  if (input.prompts.length !== 3) {
    throw new Error(
      `Claude resume-at-cursor replay scenario ${input.scenario} requires exactly three prompts.`,
    );
  }

  const sourcePromptQueue = new RecordingPromptQueue();
  const sourceOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
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
        }
      : {}),
  });

  input.entries.push({
    type: "expect_outbound",
    label: "query.open:source",
    frame: makeClaudeQueryOpenFrame({ options: sourceOptions }),
  });
  const sourceRuntime = await openRecordingQuery({
    prompt: sourcePromptQueue,
    options: sourceOptions,
  });
  const sourceIterator = sourceRuntime[Symbol.asyncIterator]();

  try {
    const sourceCursors: Array<SDKAssistantMessage["uuid"]> = [];
    for (const [index, prompt] of input.prompts.slice(0, 2).entries()) {
      const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      sourcePromptQueue.offer(message);
      const result = await recordMessagesUntilTurnResultWithCursor({
        iterator: sourceIterator,
        entries: input.entries,
        scenario: input.scenario,
      });
      if (!result.completed) {
        throw new Error(`Claude source query ended before prompt ${index + 1} completed.`);
      }
      sourceCursors.push(
        requireAssistantCursor({
          scenario: input.scenario,
          promptIndex: index + 1,
          cursor: result.assistantMessageUuid,
        }),
      );
    }
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });

    const resumeSessionAt = sourceCursors[0]!;
    input.metadata.resumeSessionAt = resumeSessionAt;
    input.metadata.sourceAssistantMessageUuids = sourceCursors;

    const resumedPromptQueue = new RecordingPromptQueue();
    const resumedOptions = {
      ...ClaudeAdapterV2.makeClaudeQueryOptions({
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
      }),
      resumeSessionAt,
    } satisfies ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
    input.entries.push({
      type: "expect_outbound",
      label: "query.open:resume_at_cursor",
      frame: makeClaudeQueryOpenFrame({ options: resumedOptions }),
    });
    const resumedMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompts[2]! });
    input.entries.push({
      type: "expect_outbound",
      label: "prompt.offer:3",
      frame: makeClaudePromptOfferFrame(resumedMessage),
    });

    const resumedRuntime = await openRecordingQuery({
      prompt: resumedPromptQueue,
      options: resumedOptions,
    });
    resumedPromptQueue.offer(resumedMessage);
    resumedPromptQueue.close();
    const resumedIterator = resumedRuntime[Symbol.asyncIterator]();
    const resumed = await recordMessagesUntilTurnResultAndFinalize({
      iterator: resumedIterator,
      entries: input.entries,
      scenario: input.scenario,
      finalize: () => {
        resumedPromptQueue.close();
        resumedRuntime.close();
      },
    });
    if (!resumed) {
      throw new Error("Claude resumed query ended before prompt 3 completed.");
    }
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

async function recordClaudeForkSessionQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly metadata: Record<string, unknown>;
  readonly forkFromPromptIndex?: 1 | 2;
  readonly sourcePromptCount?: number;
  readonly forkPromptGroups?: ReadonlyArray<ReadonlyArray<string>>;
  readonly sourceContinuationPromptCount?: number;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  if (input.prompts.length < 2) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} requires at least two prompts.`,
    );
  }
  const sourceContinuationPromptCount = input.sourceContinuationPromptCount ?? 0;
  const forkPromptEnd = input.prompts.length - sourceContinuationPromptCount;
  const sourcePromptCount = input.sourcePromptCount ?? forkPromptEnd - 1;
  if (
    sourceContinuationPromptCount < 0 ||
    sourceContinuationPromptCount >= input.prompts.length ||
    sourcePromptCount < 1 ||
    sourcePromptCount >= forkPromptEnd
  ) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} requires at least one source prompt and one fork prompt.`,
    );
  }
  const forkFromPromptIndex = input.forkFromPromptIndex ?? sourcePromptCount;
  if (forkFromPromptIndex > sourcePromptCount) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} cannot fork from prompt ${forkFromPromptIndex} after recording ${sourcePromptCount} source prompts.`,
    );
  }

  const sourcePromptQueue = new RecordingPromptQueue();
  const sourceOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
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
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open:source",
    frame: makeClaudeQueryOpenFrame({ options: sourceOptions }),
  });
  const sourceRuntime = await openRecordingQuery({
    prompt: sourcePromptQueue,
    options: sourceOptions,
  });
  const sourceIterator = sourceRuntime[Symbol.asyncIterator]();

  try {
    const sourceCursors: Array<SDKAssistantMessage["uuid"]> = [];
    for (const [index, prompt] of input.prompts.slice(0, sourcePromptCount).entries()) {
      const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      sourcePromptQueue.offer(message);
      const result = await recordMessagesUntilTurnResultWithCursor({
        iterator: sourceIterator,
        entries: input.entries,
        scenario: input.scenario,
      });
      if (!result.completed) {
        throw new Error(`Claude source query ended before prompt ${index + 1} completed.`);
      }
      sourceCursors.push(
        requireAssistantCursor({
          scenario: input.scenario,
          promptIndex: index + 1,
          cursor: result.assistantMessageUuid,
        }),
      );
    }
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });

    const upToMessageId = sourceCursors[forkFromPromptIndex - 1]!;
    const forkPrompts = input.prompts.slice(sourcePromptCount, forkPromptEnd);
    const forkPromptGroups = input.forkPromptGroups ?? [forkPrompts];
    if (
      forkPromptGroups.length === 0 ||
      forkPromptGroups.some((group) => group.length === 0) ||
      forkPromptGroups.flat().join("\n") !== forkPrompts.join("\n")
    ) {
      throw new Error(
        `Claude fork-session replay scenario ${input.scenario} has invalid fork prompt groups.`,
      );
    }
    input.metadata.sourceAssistantMessageUuids = sourceCursors;
    input.metadata.forkUpToMessageId = upToMessageId;
    const forkedNativeSessionIds: Array<string> = [];
    let promptOrdinal = sourcePromptCount;
    for (const [groupIndex, forkPrompts] of forkPromptGroups.entries()) {
      const labelSuffix = forkPromptGroups.length === 1 ? "" : `:${groupIndex + 1}`;
      input.entries.push({
        type: "expect_outbound",
        label: `session.fork${labelSuffix}`,
        frame: {
          type: "session.fork",
          sessionId: input.sessionId,
          options: {
            dir: sanitizedReplayCwd(input.scenario),
            upToMessageId,
          },
        },
      });
      const forked = await forkSession(input.sessionId, {
        dir: input.cwd,
        upToMessageId,
      });
      forkedNativeSessionIds.push(forked.sessionId);
      input.entries.push({
        type: "emit_inbound",
        label: `session.forked${labelSuffix}`,
        frame: {
          type: "session.forked",
          sessionId: forked.sessionId,
        },
      });

      const targetPromptQueue = new RecordingPromptQueue();
      const targetOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
        modelSelection: input.modelSelection,
        nativeThreadId: forked.sessionId,
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
        label: `query.open:fork${labelSuffix}`,
        frame: makeClaudeQueryOpenFrame({ options: targetOptions }),
      });
      const targetRuntime = await openRecordingQuery({
        prompt: targetPromptQueue,
        options: targetOptions,
      });
      const targetIterator = targetRuntime[Symbol.asyncIterator]();
      for (const prompt of forkPrompts) {
        promptOrdinal += 1;
        const targetMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
        input.entries.push({
          type: "expect_outbound",
          label: `prompt.offer:${promptOrdinal}`,
          frame: makeClaudePromptOfferFrame(targetMessage),
        });
        targetPromptQueue.offer(targetMessage);
        const completed = await recordMessagesUntilTurnResult({
          iterator: targetIterator,
          entries: input.entries,
          scenario: input.scenario,
        });
        if (!completed) {
          throw new Error(`Claude fork query ended before prompt ${promptOrdinal} completed.`);
        }
      }
      targetPromptQueue.close();
      targetRuntime.close();
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
    }
    input.metadata.forkedNativeSessionId = forkedNativeSessionIds[0];
    input.metadata.forkedNativeSessionIds = forkedNativeSessionIds;
    if (sourceContinuationPromptCount > 0) {
      const continuationPromptQueue = new RecordingPromptQueue();
      const continuationOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
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
        label: "query.open:source-continuation",
        frame: makeClaudeQueryOpenFrame({ options: continuationOptions }),
      });
      const continuationRuntime = await openRecordingQuery({
        prompt: continuationPromptQueue,
        options: continuationOptions,
      });
      const continuationIterator = continuationRuntime[Symbol.asyncIterator]();
      for (const prompt of input.prompts.slice(forkPromptEnd)) {
        promptOrdinal += 1;
        const continuationMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
        input.entries.push({
          type: "expect_outbound",
          label: `prompt.offer:${promptOrdinal}`,
          frame: makeClaudePromptOfferFrame(continuationMessage),
        });
        continuationPromptQueue.offer(continuationMessage);
        const completed = await recordMessagesUntilTurnResult({
          iterator: continuationIterator,
          entries: input.entries,
          scenario: input.scenario,
        });
        if (!completed) {
          throw new Error(
            `Claude source continuation ended before prompt ${promptOrdinal} completed.`,
          );
        }
      }
      continuationPromptQueue.close();
      continuationRuntime.close();
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
      input.metadata.sourceContinuationPromptCount = sourceContinuationPromptCount;
    }
  } catch (error) {
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
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
  readonly interruptAfterToolUses?: number;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  const promptQueue = new RecordingPromptQueue();
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
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
  const runtime = await openRecordingQuery({
    prompt: promptQueue,
    options,
  });
  const iterator = runtime[Symbol.asyncIterator]();
  const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompt });
  input.entries.push({
    type: "expect_outbound",
    label: input.promptOfferLabel,
    frame: makeClaudePromptOfferFrame(message),
  });
  promptQueue.offer(message);

  try {
    if (input.interruptAfter === "tool_use") {
      await recordMessagesUntilToolUse({
        iterator,
        entries: input.entries,
        scenario: input.scenario,
        toolUseCount: input.interruptAfterToolUses ?? 1,
      });
      await Effect.runPromise(Effect.sleep(Duration.millis(250)));
    }
    input.entries.push({
      type: "expect_outbound",
      label: input.interruptLabel,
      frame: { type: "query.interrupt" },
    });

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
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  readonly interruptAfterToolUses?: number;
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
    ...(input.interruptAfterToolUses === undefined
      ? {}
      : { interruptAfterToolUses: input.interruptAfterToolUses }),
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
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
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
  const secondOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
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
  const secondMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompts[1]! });
  input.entries.push({
    type: "expect_outbound",
    label: "prompt.offer:2",
    frame: makeClaudePromptOfferFrame(secondMessage),
  });

  try {
    const secondRuntime = await openRecordingQuery({
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
    | "resume_at_cursor"
    | "fork_session"
    | "fork_session_prior_turn"
    | "fork_session_merge_back_siblings"
    | "active_steering"
    | "interrupt"
    | "interrupt_restart";
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
  readonly backgroundWakeCounts?: ReadonlyArray<number>;
  readonly offerNextPromptImmediately?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  readonly interruptAfterToolUses?: number;
}): Promise<ClaudeAgentSdkReplayTranscript> {
  if (input.prompts.length === 0) {
    throw new Error(
      `Claude Agent SDK replay scenario ${input.scenario} needs at least one prompt.`,
    );
  }

  const entries: Array<ProviderReplayEntry> = [];
  const sessionId = input.sessionId ?? (await Effect.runPromise(randomUuidV4));
  const queryMode = input.queryMode ?? "streaming";
  const recordingMetadata: Record<string, unknown> = {};
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
      ...(input.backgroundWakeCounts === undefined
        ? {}
        : { backgroundWakeCounts: input.backgroundWakeCounts }),
      ...(input.offerNextPromptImmediately === undefined
        ? {}
        : { offerNextPromptImmediately: input.offerNextPromptImmediately }),
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
  } else if (queryMode === "resume_at_cursor") {
    await recordClaudeResumeAtCursorQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      metadata: recordingMetadata,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
    });
  } else if (
    queryMode === "fork_session" ||
    queryMode === "fork_session_prior_turn" ||
    queryMode === "fork_session_merge_back_siblings"
  ) {
    await recordClaudeForkSessionQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      metadata: recordingMetadata,
      ...(queryMode === "fork_session_prior_turn" ? { forkFromPromptIndex: 1 as const } : {}),
      ...(queryMode === "fork_session_merge_back_siblings"
        ? {
            sourcePromptCount: 1,
            forkPromptGroups: [[input.prompts[1]!], [input.prompts[2]!]],
            sourceContinuationPromptCount: 3,
          }
        : {}),
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
      ...(input.interruptAfterToolUses === undefined
        ? {}
        : { interruptAfterToolUses: input.interruptAfterToolUses }),
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
    provider: ClaudeAdapterV2.CLAUDE_PROVIDER,
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
      ...(input.backgroundWakeCounts === undefined
        ? {}
        : { backgroundWakeCounts: [...input.backgroundWakeCounts] }),
      ...(input.offerNextPromptImmediately === true ? { offerNextPromptImmediately: true } : {}),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
      ...(input.interruptAfterToolUses === undefined
        ? {}
        : { interruptAfterToolUses: input.interruptAfterToolUses }),
      generatedBy: "recordClaudeAgentSdkReplayTranscript",
      ...recordingMetadata,
    },
    entries,
  };
}

const decodeClaudeAgentSdkReplayTranscript = Schema.decodeUnknownEffect(
  ClaudeAgentSdkReplayTranscript,
);

export const ClaudeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  ClaudeAgentSdkReplayTranscript,
  ClaudeOrchestratorReplayHarnessError
> = {
  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeClaudeAgentSdkReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript, options) =>
    layerClaudeProviderAdapterRegistryReplay(transcript, options),
};

export function makeClaudeRestartReplayHarness(transcript: ClaudeAgentSdkReplayTranscript) {
  const queryRunner = makeReplayQueryRunner(transcript);
  return {
    harness: {
      ...ClaudeOrchestratorReplayHarness,
      makeProviderAdapterRegistryLayer: (replayed) =>
        layerClaudeProviderAdapterRegistryReplay(replayed, { queryRunner }),
    } satisfies typeof ClaudeOrchestratorReplayHarness,
    assertComplete: replayQueryRunnerService(transcript, queryRunner).assertComplete,
  };
}
