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
} from "./ClaudeAdapterV2-part2.testkit.ts";
import { makeReplayQueryRunner } from "./ClaudeAdapterV2-part2b.testkit.ts";
export * from "./ClaudeAdapterV2-part2.testkit.ts";
export * from "./ClaudeAdapterV2-part2b.testkit.ts";

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

export function serializeReplayError(error: unknown, scenario?: string): unknown {
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

export function permissionResultForRecording(input: {
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

export function permissionRequestFrame(input: {
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

export function sanitizeSdkMessageForReplay(input: {
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

export class RecordingMessageReader implements AsyncIterator<SDKMessage> {
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

export class RecordingPromptQueue implements AsyncIterable<SDKUserMessage> {
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

export async function recordMessagesUntilTurnResult(input: {
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

export async function recordMessagesUntilTurnResultAndFinalize(input: {
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

export async function recordMessagesUntilTurnResultWithCursor(input: {
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

export function requireAssistantCursor(input: {
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

export async function recordMessagesUntilTurnResults(input: {
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

export async function recordMessagesUntilIteratorDone(input: {
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

export const CLAUDE_RECORDING_WAKE_QUIET_MS = 5_000;

export function isSystemInitFrame(message: SDKMessage | undefined): boolean {
  return message?.type === "system" && message.subtype === "init";
}

export function isTaskNotificationOriginResultFrame(frame: unknown): boolean {
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

export async function recordMessagesUntilToolUse(input: {
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

export async function openRecordingQuery(input: Parameters<typeof query>[0]) {
  const executablePath = await Effect.runPromise(resolveClaudeRecordingExecutablePath(process.env));
  return query({
    ...input,
    options: {
      ...input.options,
      ...(executablePath === undefined ? {} : { pathToClaudeCodeExecutable: executablePath }),
    },
  });
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
