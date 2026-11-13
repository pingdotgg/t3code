import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import {
  CURSOR_DEFAULT_INSTANCE_ID,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
  makeCursorAdapterV2,
} from "@t3tools/provider-cursor/testing";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { RuntimePolicyV2Override } from "../RuntimePolicy.ts";

export const CursorAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(CursorAgentSdk.CURSOR_PROVIDER),
  protocol: Schema.Literal(CursorAgentSdk.CURSOR_AGENT_SDK_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type CursorAgentSdkReplayTranscript = typeof CursorAgentSdkReplayTranscript.Type;
export const decodeCursorAgentSdkReplayTranscript = Schema.decodeUnknownEffect(
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
export const isCursorAgentSdkReplayError = Schema.is(CursorAgentSdkReplayError);
export const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

export const CursorOrchestratorReplayHarnessError = Schema.Union([
  CursorAgentSdkReplayError,
  ProviderAdapterDriverCreateError,
]);
export type CursorOrchestratorReplayHarnessError = typeof CursorOrchestratorReplayHarnessError.Type;

export type CursorProtocolPayload = CursorAgentSdk.CursorAgentSdkProtocolLogEvent["payload"];
export type CursorOutgoingFrame = Extract<
  CursorAgentSdk.CursorAgentSdkProtocolLogEvent,
  { readonly direction: "outgoing" }
>["payload"];

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
  const marker = "\n\nUser message:\n";
  const markerIndex = value.indexOf(marker);
  const headerEnd = value.indexOf(":\n");
  if (markerIndex === -1 || headerEnd === -1 || headerEnd >= markerIndex) {
    return value;
  }
  return `${value.slice(0, headerEnd + 2)}<dynamic-summary>${value.slice(markerIndex)}`;
}

export function normalizeFrame(value: unknown): unknown {
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

export function sameFrame(left: unknown, right: unknown): boolean {
  return stableStringify(normalizeFrame(left)) === stableStringify(normalizeFrame(right));
}

export function makeSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

export function replayRunnerError(
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
): CursorAgentSdk.CursorAgentSdkRunner["Service"] {
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

export function layerCursorAgentSdkReplay(
  transcript: CursorAgentSdkReplayTranscript,
  options?: {
    readonly runner?: CursorAgentSdk.CursorAgentSdkRunner["Service"];
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
    readonly runner?: CursorAgentSdk.CursorAgentSdkRunner["Service"];
    readonly assertCompleteOnFinalize?: boolean;
  },
) {
  // Empty HOME prevents skill discovery from using the host's skills.
  const layerHostEnvironment = Layer.effect(
    HostProcess.Environment,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-replay-home-" });
      return { HOME: home };
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const adapter = yield* makeCursorAdapterV2({
        instanceId: CURSOR_DEFAULT_INSTANCE_ID,
        environment: yield* HostProcess.Environment,
      });
      return [adapter];
    }),
  ).pipe(
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

export function metadataFromTranscript(transcript: ProviderReplayTranscript): {
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

export function sanitizeReplayText(
  text: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  return replacements.reduce(
    (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
    text,
  );
}

export function sanitizeReplayValue(
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
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      sanitizeReplayText(key, replacements),
      sanitizeReplayValue(entry, replacements),
    ]),
  );
}

export function serializeCursorRecordingError(cause: unknown): unknown {
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

export function recordingRuntimePolicy(input: {
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

export class CursorReplayRecordingError extends Schema.TaggedError<CursorReplayRecordingError>()(
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

export interface CursorReplayRecordingInput {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly transcriptPrompts?: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly transcriptCwd?: string;
  readonly interactionMode?: "default" | "plan";
  readonly runtimePolicyOverride?: Pick<
    RuntimePolicyV2Override,
    "approvalPolicy" | "sandboxPolicy"
  >;
  readonly apiKey?: string;
  readonly interruptAfterToolStart?: boolean;
  readonly interruptAfterRunStartPromptIndex?: number;
  readonly restartBeforePromptIndex?: number;
}

