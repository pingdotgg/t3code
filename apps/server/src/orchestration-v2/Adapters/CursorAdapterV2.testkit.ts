import { Agent, type InteractionUpdate, type RunResult } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderReplayEntry,
  type ModelSelection,
  type ProviderReplayTranscript,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterDriverCreateError } from "../ProviderAdapterDriver.ts";
import { makeDriverLayer as makeProviderAdapterRegistryDriverLayer } from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  CURSOR_AGENT_SDK_PROTOCOL,
  CURSOR_PROVIDER,
  CursorAgentSdkRunner,
  CursorAgentSdkRunnerError,
  isCursorCancellationError,
  loggedCursorAgentOptions,
  loggedCursorSendOptions,
  type CursorAgentSdkOpenInput,
  type CursorAgentSdkProtocolLogEvent,
  type CursorAgentSdkRun,
  type CursorAgentSdkRunnerShape,
  type CursorAgentSdkSendInput,
  type CursorAgentSdkSession,
} from "./CursorAgentSdk.ts";
import {
  CURSOR_DEFAULT_INSTANCE_ID,
  CURSOR_DRIVER_KIND,
  CursorAdapterV2Driver,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
} from "./CursorAdapterV2.ts";
import type { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";

const CursorAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(CURSOR_PROVIDER),
  protocol: Schema.Literal(CURSOR_AGENT_SDK_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type CursorAgentSdkReplayTranscript = typeof CursorAgentSdkReplayTranscript.Type;
const decodeCursorAgentSdkReplayTranscript = Schema.decodeUnknownEffect(
  CursorAgentSdkReplayTranscript,
);

export class CursorReplayTranscriptDecodeError extends Schema.TaggedErrorClass<CursorReplayTranscriptDecodeError>()(
  "CursorReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Cursor Agent SDK replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export class CursorReplayExhaustedError extends Schema.TaggedErrorClass<CursorReplayExhaustedError>()(
  "CursorReplayExhaustedError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay transcript exhausted at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class CursorReplayFrameMismatchError extends Schema.TaggedErrorClass<CursorReplayFrameMismatchError>()(
  "CursorReplayFrameMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay frame mismatch at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class CursorReplayIncompleteError extends Schema.TaggedErrorClass<CursorReplayIncompleteError>()(
  "CursorReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export class CursorReplayRuntimeError extends Schema.TaggedErrorClass<CursorReplayRuntimeError>()(
  "CursorReplayRuntimeError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay failed at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export const CursorAgentSdkReplayError = Schema.Union([
  CursorReplayTranscriptDecodeError,
  CursorReplayExhaustedError,
  CursorReplayFrameMismatchError,
  CursorReplayIncompleteError,
  CursorReplayRuntimeError,
]);
export type CursorAgentSdkReplayError = typeof CursorAgentSdkReplayError.Type;
const isCursorAgentSdkReplayError = Schema.is(CursorAgentSdkReplayError);
const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdkRunnerError);

export const CursorOrchestratorReplayHarnessError = Schema.Union([
  CursorAgentSdkReplayError,
  ProviderAdapterDriverCreateError,
]);
export type CursorOrchestratorReplayHarnessError = typeof CursorOrchestratorReplayHarnessError.Type;

type CursorProtocolPayload = CursorAgentSdkProtocolLogEvent["payload"];
type CursorOutgoingFrame = Extract<
  CursorAgentSdkProtocolLogEvent,
  { readonly direction: "outgoing" }
>["payload"];

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

function normalizeContextHandoffText(value: string): string {
  if (!value.startsWith("Context handoff (")) {
    return value;
  }
  const marker = "\n\nUser message:\n";
  const markerIndex = value.indexOf(marker);
  const headerEnd = value.indexOf(":\n");
  if (markerIndex === -1 || headerEnd === -1 || headerEnd >= markerIndex) {
    return value;
  }
  return `${value.slice(0, headerEnd + 2)}<dynamic-summary>${value.slice(markerIndex)}`;
}

function normalizeFrame(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeContextHandoffText(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeFrame);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeFrame(entry)]),
  );
}

function sameFrame(left: unknown, right: unknown): boolean {
  return stableStringify(normalizeFrame(left)) === stableStringify(normalizeFrame(right));
}

function makeSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function replayRunnerError(
  transcript: CursorAgentSdkReplayTranscript,
  cause: unknown,
  method: string,
): CursorAgentSdkRunnerError {
  if (isCursorAgentSdkRunnerError(cause)) {
    return cause;
  }
  return new CursorAgentSdkRunnerError({
    method,
    cause: isCursorAgentSdkReplayError(cause)
      ? cause
      : new CursorReplayRuntimeError({
          scenario: transcript.scenario,
          cursor: 0,
          cause,
        }),
  });
}

export function makeCursorAgentSdkReplayRunner(
  transcript: CursorAgentSdkReplayTranscript,
): CursorAgentSdkRunnerShape {
  let cursor = 0;
  let failure: CursorAgentSdkReplayError | null = null;
  let cursorAdvanced = makeSignal();

  const recordFailure = <Error extends CursorAgentSdkReplayError>(error: Error): Error => {
    failure = error;
    return error;
  };

  const fail = (error: CursorAgentSdkReplayError): never => {
    throw recordFailure(error);
  };

  const advance = () => {
    cursor += 1;
    const signal = cursorAdvanced;
    cursorAdvanced = makeSignal();
    signal.resolve();
  };

  const assertOutbound = (actual: CursorOutgoingFrame) => {
    if (failure !== null) {
      throw failure;
    }
    const entry = transcript.entries[cursor];
    if (entry === undefined) {
      return fail(
        new CursorReplayExhaustedError({
          scenario: transcript.scenario,
          cursor,
          actual,
        }),
      );
    }
    if (entry.type !== "expect_outbound" || !sameFrame(entry.frame, actual)) {
      return fail(
        new CursorReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          expected: entry.type === "expect_outbound" ? entry.frame : entry,
          actual,
        }),
      );
    }
    advance();
  };

  const consumeInbound = <Type extends CursorProtocolPayload["type"]>(
    type: Type,
  ): Extract<CursorProtocolPayload, { readonly type: Type }> => {
    const entry = transcript.entries[cursor];
    if (
      entry === undefined ||
      entry.type !== "emit_inbound" ||
      typeof entry.frame !== "object" ||
      entry.frame === null ||
      Reflect.get(entry.frame, "type") !== type
    ) {
      return fail(
        new CursorReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          expected: { type },
          actual: entry,
        }),
      );
    }
    const frame = entry.frame as Extract<CursorProtocolPayload, { readonly type: Type }>;
    advance();
    return frame;
  };

  const waitForRun = <Error>(
    runId: string,
    sendInput: CursorAgentSdkSendInput<Error>,
  ): Effect.Effect<RunResult, CursorAgentSdkReplayError> =>
    Effect.gen(function* () {
      while (true) {
        if (failure !== null) {
          return yield* failure;
        }
        const entry = transcript.entries[cursor];
        if (entry === undefined) {
          return yield* recordFailure(
            new CursorReplayExhaustedError({
              scenario: transcript.scenario,
              cursor,
              actual: { type: "run.completed", runId },
            }),
          );
        }
        if (entry.type === "expect_outbound") {
          const signal = cursorAdvanced;
          yield* Effect.promise(() => signal.promise);
          continue;
        }
        if (entry.type === "runtime_exit") {
          advance();
          if (entry.status === "success") {
            continue;
          }
          return yield* recordFailure(
            new CursorReplayRuntimeError({
              scenario: transcript.scenario,
              cursor: cursor - 1,
              cause: entry.error ?? entry.status,
            }),
          );
        }
        if (
          typeof entry.frame !== "object" ||
          entry.frame === null ||
          typeof Reflect.get(entry.frame, "type") !== "string"
        ) {
          return yield* recordFailure(
            new CursorReplayFrameMismatchError({
              scenario: transcript.scenario,
              cursor,
              expected: { type: "interaction.update | run.completed" },
              actual: entry.frame,
            }),
          );
        }
        const frame = entry.frame as CursorProtocolPayload;
        if (frame.type === "interaction.update") {
          if (frame.runId !== runId) {
            return yield* recordFailure(
              new CursorReplayFrameMismatchError({
                scenario: transcript.scenario,
                cursor,
                expected: { runId },
                actual: frame,
              }),
            );
          }
          advance();
          yield* (sendInput.onDelta?.(frame.update) ?? Effect.void).pipe(
            Effect.mapError((cause) =>
              recordFailure(
                new CursorReplayRuntimeError({
                  scenario: transcript.scenario,
                  cursor: cursor - 1,
                  cause,
                }),
              ),
            ),
          );
          yield* Effect.yieldNow;
          continue;
        }
        if (frame.type === "run.completed") {
          if (frame.result.id !== runId) {
            return yield* recordFailure(
              new CursorReplayFrameMismatchError({
                scenario: transcript.scenario,
                cursor,
                expected: { runId },
                actual: frame.result,
              }),
            );
          }
          advance();
          return frame.result;
        }
        return yield* recordFailure(
          new CursorReplayFrameMismatchError({
            scenario: transcript.scenario,
            cursor,
            expected: { type: "interaction.update | run.completed" },
            actual: frame,
          }),
        );
      }
    });

  return {
    open: (input: CursorAgentSdkOpenInput) =>
      Effect.try({
        try: () => {
          assertOutbound({
            type: "agent.open",
            operation: input.operation,
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            options: loggedCursorAgentOptions(input.options),
          });
          const opened = consumeInbound("agent.opened");
          const session: CursorAgentSdkSession = {
            agentId: opened.agentId,
            send: (sendInput) =>
              Effect.try({
                try: () => {
                  assertOutbound({
                    type: "run.start",
                    message: sendInput.message,
                    options: loggedCursorSendOptions(sendInput.options),
                  });
                  const started = consumeInbound("run.started");
                  const run: CursorAgentSdkRun = {
                    runId: started.runId,
                    agentId: started.agentId,
                    wait: waitForRun(started.runId, sendInput).pipe(
                      Effect.mapError((cause) =>
                        replayRunnerError(transcript, cause, "replay.run.wait"),
                      ),
                    ),
                    cancel: Effect.try({
                      try: () =>
                        assertOutbound({
                          type: "run.cancel",
                          runId: started.runId,
                        }),
                      catch: (cause) => replayRunnerError(transcript, cause, "replay.run.cancel"),
                    }),
                  };
                  return run;
                },
                catch: (cause) => replayRunnerError(transcript, cause, "replay.session.send"),
              }),
            listMessages: Effect.try({
              try: () => {
                assertOutbound({
                  type: "agent.messages.list",
                  agentId: opened.agentId,
                });
                return consumeInbound("agent.messages").messages;
              },
              catch: (cause) => replayRunnerError(transcript, cause, "replay.agent.messages.list"),
            }),
            close: Effect.try({
              try: () =>
                assertOutbound({
                  type: "agent.close",
                  agentId: opened.agentId,
                }),
              catch: (cause) => replayRunnerError(transcript, cause, "replay.agent.close"),
            }),
          };
          return session;
        },
        catch: (cause) => replayRunnerError(transcript, cause, "replay.agent.open"),
      }),
    assertComplete: Effect.try({
      try: () => {
        if (failure !== null) {
          throw failure;
        }
        if (cursor !== transcript.entries.length) {
          throw new CursorReplayIncompleteError({
            scenario: transcript.scenario,
            cursor,
            remaining: transcript.entries.length - cursor,
          });
        }
      },
      catch: (cause) => replayRunnerError(transcript, cause, "replay.assertComplete"),
    }),
  };
}

export function makeCursorAgentSdkReplayLayer(
  transcript: CursorAgentSdkReplayTranscript,
  options?: {
    readonly runner?: CursorAgentSdkRunnerShape;
    readonly assertCompleteOnFinalize?: boolean;
  },
): Layer.Layer<CursorAgentSdkRunner> {
  const runner = options?.runner ?? makeCursorAgentSdkReplayRunner(transcript);
  return Layer.effect(
    CursorAgentSdkRunner,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        options?.assertCompleteOnFinalize === false
          ? Effect.void
          : runner.assertComplete.pipe(Effect.orDie),
      );
      return CursorAgentSdkRunner.of(runner);
    }),
  );
}

function makeReplayServerConfig(
  scenario: string,
): Effect.Effect<
  ServerConfig["Service"],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectory({
      prefix: `t3-orchestration-v2-cursor-${scenario}-`,
    });
    const stateDir = path.join(baseDir, "userdata");
    const logsDir = path.join(stateDir, "logs");
    const providerLogsDir = path.join(logsDir, "provider");
    const terminalLogsDir = path.join(logsDir, "terminals");
    const attachmentsDir = path.join(stateDir, "attachments");
    const worktreesDir = path.join(baseDir, "worktrees");
    const providerStatusCacheDir = path.join(baseDir, "caches");
    for (const directory of [
      stateDir,
      logsDir,
      providerLogsDir,
      terminalLogsDir,
      attachmentsDir,
      worktreesDir,
      providerStatusCacheDir,
    ]) {
      yield* fs.makeDirectory(directory, { recursive: true });
    }
    return {
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: undefined,
      cwd: process.cwd(),
      baseDir,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: false,
      startupPresentation: "browser",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      stateDir,
      dbPath: path.join(stateDir, "state.sqlite"),
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      settingsPath: path.join(stateDir, "settings.json"),
      providerStatusCacheDir,
      worktreesDir,
      attachmentsDir,
      logsDir,
      serverLogPath: path.join(logsDir, "server.log"),
      serverTracePath: path.join(logsDir, "server.trace.ndjson"),
      providerLogsDir,
      providerEventLogPath: path.join(providerLogsDir, "events.log"),
      terminalLogsDir,
      anonymousIdPath: path.join(stateDir, "anonymous-id"),
      environmentIdPath: path.join(stateDir, "environment-id"),
      serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
      secretsDir: path.join(stateDir, "secrets"),
    };
  });
}

export function makeCursorProviderAdapterRegistryReplayLayer(
  transcript: CursorAgentSdkReplayTranscript,
  options?: {
    readonly runner?: CursorAgentSdkRunnerShape;
    readonly assertCompleteOnFinalize?: boolean;
  },
) {
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return makeProviderAdapterRegistryDriverLayer({
    drivers: [CursorAdapterV2Driver],
    configMap: {
      [CURSOR_DEFAULT_INSTANCE_ID]: {
        driver: CURSOR_DRIVER_KIND,
      },
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        makeCursorAgentSdkReplayLayer(transcript, options),
        serverConfigLayer,
        NodeServices.layer,
        idAllocatorLayer,
      ),
    ),
  );
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

export const CursorOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CursorAgentSdkReplayTranscript,
  CursorOrchestratorReplayHarnessError
> = {
  driver: CURSOR_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeCursorAgentSdkReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new CursorReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    makeCursorProviderAdapterRegistryReplayLayer(transcript),
};

function sanitizeReplayValue(
  value: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof value === "string") {
    return replacements.reduce(
      (text, [from, to]) => (from.length === 0 ? text : text.replaceAll(from, to)),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReplayValue(entry, replacements));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeReplayValue(entry, replacements)]),
  );
}

function serializeCursorRecordingError(cause: unknown): unknown {
  if (typeof cause !== "object" || cause === null) {
    return cause;
  }
  return {
    name: typeof Reflect.get(cause, "name") === "string" ? Reflect.get(cause, "name") : "Error",
    message:
      typeof Reflect.get(cause, "message") === "string"
        ? Reflect.get(cause, "message")
        : String(cause),
  };
}

function makeRecordingSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function waitForRecordingSignal(signal: Promise<void>, description: string): Promise<void> {
  const controller = new AbortController();
  const timeout = Effect.runPromise(
    Effect.sleep("30 seconds").pipe(
      Effect.andThen(Effect.die(`Timed out waiting for ${description}.`)),
    ),
    { signal: controller.signal },
  );
  try {
    await Promise.race([signal, timeout]);
  } finally {
    controller.abort();
  }
}

function recordingRuntimePolicy(input: {
  readonly cwd: string;
  readonly interactionMode: "default" | "plan";
}): ProviderAdapterV2RuntimePolicy {
  return {
    runtimeMode: "full-access",
    interactionMode: input.interactionMode,
    cwd: input.cwd,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "dangerFullAccess",
      networkAccess: true,
    },
  };
}

export async function recordCursorAgentSdkReplayTranscript(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly interactionMode?: "default" | "plan";
  readonly apiKey?: string;
  readonly interruptAfterToolStart?: boolean;
  readonly interruptAfterRunStartPromptIndex?: number;
  readonly restartBeforePromptIndex?: number;
}): Promise<CursorAgentSdkReplayTranscript> {
  if (input.interruptAfterToolStart === true && input.prompts.length !== 1) {
    throw new Error("Cursor interrupt recordings require exactly one prompt.");
  }
  if (
    input.interruptAfterToolStart === true &&
    input.interruptAfterRunStartPromptIndex !== undefined
  ) {
    throw new Error("Cursor recordings cannot use both interrupt triggers.");
  }
  if (
    input.interruptAfterRunStartPromptIndex !== undefined &&
    (input.interruptAfterRunStartPromptIndex < 0 ||
      input.interruptAfterRunStartPromptIndex >= input.prompts.length)
  ) {
    throw new Error("Cursor interrupt prompt index is outside the prompt list.");
  }
  const entries: Array<ProviderReplayEntry> = [];
  const interactionMode = input.interactionMode ?? "default";
  const runtimePolicy = recordingRuntimePolicy({
    cwd: input.cwd,
    interactionMode,
  });
  const options = makeCursorAgentOptions({
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    modelSelection: input.modelSelection,
    runtimePolicy,
    threadId: "thread:cursor-replay" as ThreadId,
  });
  entries.push({
    type: "expect_outbound",
    label: "agent.open",
    frame: {
      type: "agent.open",
      operation: "create",
      options: loggedCursorAgentOptions(options),
    },
  });

  let agent = await Agent.create(options);
  const nativeAgentId = agent.agentId;
  entries.push({
    type: "emit_inbound",
    label: "agent.opened",
    frame: {
      type: "agent.opened",
      agentId: agent.agentId,
    },
  });

  const replacements: ReadonlyArray<readonly [string, string]> = [
    [input.cwd, `/tmp/cursor-replay-${input.scenario}`],
  ];

  try {
    for (const [index, prompt] of input.prompts.entries()) {
      if (input.restartBeforePromptIndex === index) {
        entries.push({
          type: "expect_outbound",
          label: `agent.close:before-prompt-${index + 1}`,
          frame: {
            type: "agent.close",
            agentId: nativeAgentId,
          },
        });
        agent.close();
        entries.push({
          type: "expect_outbound",
          label: `agent.resume:before-prompt-${index + 1}`,
          frame: {
            type: "agent.open",
            operation: "resume",
            agentId: nativeAgentId,
            options: loggedCursorAgentOptions(options),
          },
        });
        agent = await Agent.resume(nativeAgentId, options);
        entries.push({
          type: "emit_inbound",
          label: `agent.resumed:before-prompt-${index + 1}`,
          frame: {
            type: "agent.opened",
            agentId: agent.agentId,
          },
        });
      }
      const sendOptions = {
        model: cursorSdkModelSelection(input.modelSelection),
        mode: interactionMode === "plan" ? "plan" : "agent",
      } as const;
      entries.push({
        type: "expect_outbound",
        label: `run.start:${index + 1}`,
        frame: {
          type: "run.start",
          message: prompt,
          options: loggedCursorSendOptions(sendOptions),
        },
      });
      const pendingUpdates: Array<InteractionUpdate> = [];
      let runReady = false;
      let runId = "";
      let updatesPaused = false;
      const toolStarted = makeRecordingSignal();
      const runActivityStarted = makeRecordingSignal();
      const resumeUpdates = makeRecordingSignal();
      let interruptTriggerObserved = false;
      let callbackChain = Promise.resolve();
      const recordUpdate = async (update: InteractionUpdate) => {
        if (updatesPaused) {
          await resumeUpdates.promise;
        }
        entries.push({
          type: "emit_inbound",
          label: update.type,
          frame: {
            type: "interaction.update",
            runId,
            update: sanitizeReplayValue(update, replacements) as InteractionUpdate,
          },
        });
        if (
          input.interruptAfterToolStart === true &&
          !interruptTriggerObserved &&
          update.type === "tool-call-started"
        ) {
          interruptTriggerObserved = true;
          updatesPaused = true;
          toolStarted.resolve();
        }
      };
      const scheduleUpdate = (update: InteractionUpdate): Promise<void> => {
        callbackChain = callbackChain.then(() => recordUpdate(update));
        return callbackChain;
      };
      const run = await agent.send(prompt, {
        ...sendOptions,
        onDelta: async ({ update }) => {
          runActivityStarted.resolve();
          if (!runReady) {
            pendingUpdates.push(update);
            return;
          }
          await scheduleUpdate(update);
        },
      });
      runId = run.id;
      entries.push({
        type: "emit_inbound",
        label: `run.started:${index + 1}`,
        frame: {
          type: "run.started",
          runId: run.id,
          agentId: run.agentId,
        },
      });
      runReady = true;
      for (const update of pendingUpdates) {
        void scheduleUpdate(update);
      }
      const resultPromise = run.wait().then(
        (result) => ({ type: "success" as const, result }),
        (cause: unknown) => ({ type: "failure" as const, cause }),
      );
      if (input.interruptAfterRunStartPromptIndex === index) {
        await waitForRecordingSignal(
          runActivityStarted.promise,
          "Cursor SDK run activity before interrupt",
        );
        entries.push({
          type: "expect_outbound",
          label: `run.cancel:${index + 1}`,
          frame: {
            type: "run.cancel",
            runId: run.id,
          },
        });
        await run.cancel().catch((cause: unknown) => {
          if (!isCursorCancellationError(cause)) {
            throw cause;
          }
        });
      }
      if (input.interruptAfterToolStart === true) {
        await waitForRecordingSignal(
          toolStarted.promise,
          "Cursor SDK tool-call-started before interrupt",
        );
        entries.push({
          type: "expect_outbound",
          label: `run.cancel:${index + 1}`,
          frame: {
            type: "run.cancel",
            runId: run.id,
          },
        });
        const cancelPromise = run.cancel().catch((cause: unknown) => {
          if (!isCursorCancellationError(cause)) {
            throw cause;
          }
        });
        updatesPaused = false;
        resumeUpdates.resolve();
        await cancelPromise;
      }
      const outcome = await resultPromise;
      await callbackChain;
      if (outcome.type === "success") {
        entries.push({
          type: "emit_inbound",
          label: `run.completed:${index + 1}`,
          frame: {
            type: "run.completed",
            result: sanitizeReplayValue(outcome.result, replacements) as RunResult,
          },
        });
      } else if (
        (input.interruptAfterToolStart === true ||
          input.interruptAfterRunStartPromptIndex === index) &&
        isCursorCancellationError(outcome.cause)
      ) {
        entries.push({
          type: "runtime_exit",
          status: "cancelled",
          error: serializeCursorRecordingError(outcome.cause),
        });
      } else {
        throw outcome.cause;
      }
    }
  } finally {
    entries.push({
      type: "expect_outbound",
      label: "agent.close",
      frame: {
        type: "agent.close",
        agentId: nativeAgentId,
      },
    });
    agent.close();
  }

  return {
    provider: CURSOR_PROVIDER,
    protocol: CURSOR_AGENT_SDK_PROTOCOL,
    version: "1",
    scenario: input.scenario,
    metadata: {
      generatedBy: "recordCursorAgentSdkReplayTranscript",
      nativeAgentId,
    },
    entries,
  };
}
