import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import type { InteractionUpdate, RunResult } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderReplayEntry,
  ProviderSessionId,
  ThreadId,
  type ModelSelection,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { CursorAdapterV2Driver } from "@t3tools/provider-cursor/server";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import {
  CURSOR_DEFAULT_INSTANCE_ID,
  CURSOR_DRIVER_KIND,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
} from "@t3tools/provider-cursor/testing";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { RuntimePolicyV2Override } from "../RuntimePolicy.ts";

const CursorAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(CursorAgentSdk.CURSOR_PROVIDER),
  protocol: Schema.Literal(CursorAgentSdk.CURSOR_AGENT_SDK_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type CursorAgentSdkReplayTranscript = typeof CursorAgentSdkReplayTranscript.Type;
const decodeCursorAgentSdkReplayTranscript = Schema.decodeUnknownEffect(
  CursorAgentSdkReplayTranscript,
);

export class CursorReplayTranscriptDecodeError extends Schema.TaggedError<CursorReplayTranscriptDecodeError>()(
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

export class CursorReplayExhaustedError extends Schema.TaggedError<CursorReplayExhaustedError>()(
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

export class CursorReplayFrameMismatchError extends Schema.TaggedError<CursorReplayFrameMismatchError>()(
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

export class CursorReplayIncompleteError extends Schema.TaggedError<CursorReplayIncompleteError>()(
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

export class CursorReplayRuntimeError extends Schema.TaggedError<CursorReplayRuntimeError>()(
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
const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

export const CursorOrchestratorReplayHarnessError = Schema.Union([
  CursorAgentSdkReplayError,
  ProviderAdapterDriverCreateError,
]);
export type CursorOrchestratorReplayHarnessError = typeof CursorOrchestratorReplayHarnessError.Type;

type CursorProtocolPayload = CursorAgentSdk.CursorAgentSdkProtocolLogEvent["payload"];
type CursorOutgoingFrame = Extract<
  CursorAgentSdk.CursorAgentSdkProtocolLogEvent,
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
): CursorAgentSdk.CursorAgentSdkRunnerError {
  if (isCursorAgentSdkRunnerError(cause)) {
    return cause;
  }
  return new CursorAgentSdk.CursorAgentSdkRunnerError({
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
): CursorAgentSdk.CursorAgentSdkRunnerShape {
  let cursor = 0;
  let failure: CursorAgentSdkReplayError | null = null;
  let cursorAdvanced = makeSignal();

  const recordFailure = <Error extends CursorAgentSdkReplayError>(error: Error): Error => {
    failure = error;
    cursorAdvanced.resolve();
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
    sendInput: CursorAgentSdk.CursorAgentSdkSendInput<Error>,
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
          const expectedCancel = {
            type: "run.cancel",
            runId,
          };
          if (!sameFrame(entry.frame, expectedCancel)) {
            return yield* recordFailure(
              new CursorReplayFrameMismatchError({
                scenario: transcript.scenario,
                cursor,
                expected: expectedCancel,
                actual: entry.frame,
              }),
            );
          }
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
    open: (input: CursorAgentSdk.CursorAgentSdkOpenInput) =>
      Effect.try({
        try: () => {
          assertOutbound({
            type: "agent.open",
            operation: input.operation,
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            options: CursorAgentSdk.loggedCursorAgentOptions(input.options),
          });
          const opened = consumeInbound("agent.opened");
          const session: CursorAgentSdk.CursorAgentSdkSession = {
            agentId: opened.agentId,
            send: (sendInput) =>
              Effect.try({
                try: () => {
                  assertOutbound({
                    type: "run.start",
                    message: sendInput.message,
                    options: CursorAgentSdk.loggedCursorSendOptions(sendInput.options),
                  });
                  const started = consumeInbound("run.started");
                  const run: CursorAgentSdk.CursorAgentSdkRun = {
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

function layerCursorAgentSdkReplay(
  transcript: CursorAgentSdkReplayTranscript,
  options?: {
    readonly runner?: CursorAgentSdk.CursorAgentSdkRunnerShape;
    readonly assertCompleteOnFinalize?: boolean;
  },
): Layer.Layer<CursorAgentSdk.CursorAgentSdkRunner> {
  const runner = options?.runner ?? makeCursorAgentSdkReplayRunner(transcript);
  return Layer.effect(
    CursorAgentSdk.CursorAgentSdkRunner,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        options?.assertCompleteOnFinalize === false
          ? Effect.void
          : runner.assertComplete.pipe(Effect.orDie),
      );
      return CursorAgentSdk.CursorAgentSdkRunner.of(runner);
    }),
  );
}

export function layer(
  transcript: CursorAgentSdkReplayTranscript,
  options?: {
    readonly runner?: CursorAgentSdk.CursorAgentSdkRunnerShape;
    readonly assertCompleteOnFinalize?: boolean;
  },
) {
  // Skill discovery also scans user roots under HOME; an empty HOME keeps
  // replays from picking up the host's own skills.
  const layerHostEnvironment = Layer.effect(
    HostProcessEnvironment,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-replay-home-" });
      return { HOME: home };
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return ProviderAdapterRegistry.layerFromDrivers({
    drivers: [CursorAdapterV2Driver],
    configMap: {
      [CURSOR_DEFAULT_INSTANCE_ID]: {
        driver: CURSOR_DRIVER_KIND,
      },
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCursorAgentSdkReplay(transcript, options),
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        layerHostEnvironment,
        NodeServices.layer,
        IdAllocator.layer,
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
  driver: CursorAgentSdk.CURSOR_PROVIDER,
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
  makeProviderAdapterRegistryLayer: (transcript) => layer(transcript),
};

function sanitizeReplayText(
  text: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  return replacements.reduce(
    (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
    text,
  );
}

function sanitizeReplayValue(
  value: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof value === "string") {
    return sanitizeReplayText(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReplayValue(entry, replacements));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  // Keys too: grep results are keyed by workspace path.
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      sanitizeReplayText(key, replacements),
      sanitizeReplayValue(entry, replacements),
    ]),
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

function recordingRuntimePolicy(input: {
  readonly cwd: string;
  readonly interactionMode: "default" | "plan";
  readonly override?: Pick<RuntimePolicyV2Override, "approvalPolicy" | "sandboxPolicy">;
}): ProviderAdapter.ProviderAdapterV2RuntimePolicy {
  return {
    runtimeMode: "full-access",
    interactionMode: input.interactionMode,
    cwd: input.cwd,
    approvalPolicy: input.override?.approvalPolicy ?? "never",
    sandboxPolicy: input.override?.sandboxPolicy ?? {
      type: "dangerFullAccess",
      networkAccess: true,
    },
  };
}

class CursorReplayRecordingError extends Schema.TaggedError<CursorReplayRecordingError>()(
  "CursorReplayRecordingError",
  {
    scenario: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay recording failed in scenario ${this.scenario}: ${this.reason}`;
  }
}

interface CursorReplayRecordingInput {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  /** Stable transcript representation when runtime-only paths were substituted into prompts. */
  readonly transcriptPrompts?: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  /** Stable fixture cwd used to sanitize runtime-only workspace paths in recorded updates. */
  readonly transcriptCwd?: string;
  readonly interactionMode?: "default" | "plan";
  /** The replay fixture's policy override, so the recorded agent.open frame matches replay. */
  readonly runtimePolicyOverride?: Pick<
    RuntimePolicyV2Override,
    "approvalPolicy" | "sandboxPolicy"
  >;
  readonly apiKey?: string;
  readonly interruptAfterToolStart?: boolean;
  readonly interruptAfterRunStartPromptIndex?: number;
  readonly restartBeforePromptIndex?: number;
}

/**
 * Records a live Cursor Agent SDK session as a replay transcript. The SDK is
 * driven through the same runner the adapter uses; its protocol frames are the
 * transcript entries.
 */
export const recordCursorAgentSdkReplayTranscript = Effect.fn(
  "recordCursorAgentSdkReplayTranscript",
)(function* (input: CursorReplayRecordingInput) {
  const invalid = (reason: string) =>
    new CursorReplayRecordingError({ scenario: input.scenario, reason });
  const outsidePrompts = (index: number | undefined) =>
    index !== undefined && (index < 0 || index >= input.prompts.length);
  if (
    input.transcriptPrompts !== undefined &&
    input.transcriptPrompts.length !== input.prompts.length
  ) {
    return yield* invalid("Cursor transcript prompts must match the runtime prompt count.");
  }
  if (input.interruptAfterToolStart === true && input.prompts.length !== 1) {
    return yield* invalid("Cursor interrupt recordings require exactly one prompt.");
  }
  if (
    input.interruptAfterToolStart === true &&
    input.interruptAfterRunStartPromptIndex !== undefined
  ) {
    return yield* invalid("Cursor recordings cannot use both interrupt triggers.");
  }
  if (outsidePrompts(input.interruptAfterRunStartPromptIndex)) {
    return yield* invalid("Cursor interrupt prompt index is outside the prompt list.");
  }
  if (outsidePrompts(input.restartBeforePromptIndex)) {
    return yield* invalid("Cursor restart prompt index is outside the prompt list.");
  }

  const entries: Array<ProviderReplayEntry> = [];
  const interactionMode = input.interactionMode ?? "default";
  const threadId = ThreadId.make("thread:cursor-replay");
  const options = makeCursorAgentOptions({
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    modelSelection: input.modelSelection,
    runtimePolicy: recordingRuntimePolicy({
      cwd: input.cwd,
      interactionMode,
      ...(input.runtimePolicyOverride === undefined
        ? {}
        : { override: input.runtimePolicyOverride }),
    }),
    threadId,
    mcpSession: undefined,
  });
  const sendOptions = {
    model: cursorSdkModelSelection(input.modelSelection),
    mode: interactionMode === "plan" ? "plan" : "agent",
  } as const;
  // Agents sometimes search the workspace's parent too; map it to /tmp so the
  // recording host's temp layout stays out of the fixture.
  const replacements: ReadonlyArray<readonly [string, string]> = [
    [input.cwd, input.transcriptCwd ?? `/tmp/cursor-replay-${input.scenario}`],
    [input.cwd.slice(0, input.cwd.lastIndexOf("/")), "/tmp"],
  ];
  let runsStarted = 0;
  let resuming = false;

  const frameLabel = (frame: CursorProtocolPayload): string => {
    const beforeNextPrompt = `before-prompt-${runsStarted + 1}`;
    switch (frame.type) {
      case "agent.open":
        return resuming ? `agent.resume:${beforeNextPrompt}` : "agent.open";
      case "agent.opened":
        return resuming ? `agent.resumed:${beforeNextPrompt}` : "agent.opened";
      case "agent.close":
        return runsStarted < input.prompts.length
          ? `agent.close:${beforeNextPrompt}`
          : "agent.close";
      case "interaction.update":
        return frame.update.type;
      default:
        return `${frame.type}:${runsStarted}`;
    }
  };

  const transcriptFrame = (frame: CursorProtocolPayload): CursorProtocolPayload => {
    switch (frame.type) {
      case "run.start":
        return { ...frame, message: input.transcriptPrompts?.[runsStarted - 1] ?? frame.message };
      case "interaction.update":
        return {
          ...frame,
          update: sanitizeReplayValue(frame.update, replacements) as InteractionUpdate,
        };
      case "run.completed":
        return { ...frame, result: sanitizeReplayValue(frame.result, replacements) as RunResult };
      default:
        return frame;
    }
  };

  // In a mid-tool interrupt recording, frames after the first tool-call-started
  // are held until run.cancel is recorded, so the cancel directly follows its
  // trigger. Holding appends rather than waits: updates can arrive while send
  // is still flushing them, and blocking there would never return.
  let awaitingToolStart = input.interruptAfterToolStart === true;
  let heldUntilCancel: Array<ProviderReplayEntry> | undefined;

  const recordFrame = (event: CursorAgentSdk.CursorAgentSdkProtocolLogEvent) =>
    Effect.sync(() => {
      const frame = event.payload;
      if (frame.type === "agent.open") {
        resuming = frame.operation === "resume";
      }
      if (frame.type === "run.start") {
        runsStarted += 1;
      }
      const entry: ProviderReplayEntry = {
        type: event.direction === "outgoing" ? "expect_outbound" : "emit_inbound",
        label: frameLabel(frame),
        frame: transcriptFrame(frame),
      };
      if (heldUntilCancel !== undefined && frame.type !== "run.cancel") {
        heldUntilCancel.push(entry);
        return;
      }
      entries.push(entry);
      if (frame.type === "run.cancel" && heldUntilCancel !== undefined) {
        entries.push(...heldUntilCancel);
        heldUntilCancel = undefined;
      }
      if (
        awaitingToolStart &&
        frame.type === "interaction.update" &&
        frame.update.type === "tool-call-started"
      ) {
        awaitingToolStart = false;
        heldUntilCancel = [];
      }
    });
  const runner = CursorAgentSdk.makeCursorAgentSdkRunner(() => recordFrame);

  const awaitSignal = (signal: Deferred.Deferred<void>, description: string) =>
    Deferred.await(signal).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(invalid(`Timed out waiting for ${description}.`)),
      }),
    );

  const runPrompt = Effect.fnUntraced(function* (
    session: CursorAgentSdk.CursorAgentSdkSession,
    prompt: string,
    index: number,
  ) {
    const interruptAfterRunStart = input.interruptAfterRunStartPromptIndex === index;
    const firstUpdate = yield* Deferred.make<void>();
    const toolStarted = yield* Deferred.make<void>();
    const cancelSent = yield* Deferred.make<void>();
    let sent = false;
    const run = yield* session.send({
      message: prompt,
      options: sendOptions,
      onDelta: (update) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(firstUpdate, undefined);
          if (input.interruptAfterToolStart !== true || update.type !== "tool-call-started") {
            return;
          }
          const first = yield* Deferred.succeed(toolStarted, undefined);
          // Also hold the SDK's callback until the cancel is sent, as the async
          // recorder did: with the tool left running, all three live probes hit
          // the AbortError described below. Inside send the hold would never
          // return, so updates flushed there rely on recordFrame's ordering.
          if (first && sent) {
            yield* Deferred.await(cancelSent);
          }
        }),
    });
    sent = true;
    // Wait on the run before cancelling it, as the adapter does.
    const waiting = yield* run.wait.pipe(Effect.forkChild({ startImmediately: true }));
    if (interruptAfterRunStart) {
      yield* awaitSignal(firstUpdate, "Cursor SDK run activity before interrupt");
      yield* run.cancel;
    }
    if (input.interruptAfterToolStart === true) {
      yield* awaitSignal(toolStarted, "Cursor SDK tool-call-started before interrupt");
      // Cancelling synchronously from the SDK's tool-call-started callback
      // leaves an unhandled AbortError inside @cursor/sdk that kills the
      // process (reproduced on 1.0.22, 1.0.31, and 1.0.32). Cancelling from a
      // later timer was clean in the same probes; 10 ms is that deferral.
      yield* Effect.sleep("10 millis");
      const cancelling = yield* run.cancel.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(cancelSent, undefined);
      yield* Fiber.join(cancelling);
    }
    yield* Fiber.join(waiting).pipe(
      Effect.catchIf(
        (error) =>
          (input.interruptAfterToolStart === true || interruptAfterRunStart) &&
          CursorAgentSdk.isCursorCancellationError(error.cause),
        (error) =>
          Effect.sync(() => {
            entries.push({
              type: "runtime_exit",
              status: "cancelled",
              error: serializeCursorRecordingError(error.cause),
            });
          }),
      ),
    );
  });

  const runPrompts = (session: CursorAgentSdk.CursorAgentSdkSession, from: number, to: number) =>
    Effect.forEach(
      input.prompts.slice(from, to),
      (prompt, offset) => runPrompt(session, prompt, from + offset),
      { discard: true },
    );

  const withAgent = <A, E>(
    open:
      | { readonly operation: "create" }
      | { readonly operation: "resume"; readonly agentId: string },
    use: (session: CursorAgentSdk.CursorAgentSdkSession) => Effect.Effect<A, E>,
  ) =>
    Effect.acquireUseRelease(
      runner.open({
        ...open,
        options,
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session:cursor-replay"),
      }),
      use,
      (session) => session.close,
    );

  const restartAt = input.restartBeforePromptIndex ?? input.prompts.length;
  const nativeAgentId = yield* withAgent({ operation: "create" }, (session) =>
    runPrompts(session, 0, restartAt).pipe(Effect.as(session.agentId)),
  );
  if (restartAt < input.prompts.length) {
    yield* withAgent({ operation: "resume", agentId: nativeAgentId }, (session) =>
      runPrompts(session, restartAt, input.prompts.length),
    );
  }

  return {
    provider: CursorAgentSdk.CURSOR_PROVIDER,
    protocol: CursorAgentSdk.CURSOR_AGENT_SDK_PROTOCOL,
    version: "1",
    scenario: input.scenario,
    metadata: {
      generatedBy: "recordCursorAgentSdkReplayTranscript",
      nativeAgentId,
    },
    entries,
  } satisfies CursorAgentSdkReplayTranscript;
});
