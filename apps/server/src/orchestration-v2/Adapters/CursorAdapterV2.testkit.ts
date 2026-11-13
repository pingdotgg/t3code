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
import type { CursorAgentSdkReplayTranscript, CursorProtocolPayload, CursorReplayRecordingInput } from "./CursorAdapterV2-part2.testkit.ts";
import { CursorReplayRecordingError, recordingRuntimePolicy, sanitizeReplayValue, serializeCursorRecordingError } from "./CursorAdapterV2-part2.testkit.ts";

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
    platform: yield* HostProcess.Platform,
  });
  const sendOptions = {
    model: cursorSdkModelSelection(input.modelSelection),
    mode: interactionMode === "plan" ? "plan" : "agent",
  } as const;
  // Agents search parent directories too; normalize the recording host's temp layout.
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

  // Hold frames after tool-call-started until run.cancel. Append without waiting because updates can arrive during send.
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
  const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => recordFrame);

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
          if (first && sent) {
            yield* Deferred.await(cancelSent);
          }
        }),
    });
    sent = true;
    const waiting = yield* run.wait.pipe(Effect.forkChild({ startImmediately: true }));
    if (interruptAfterRunStart) {
      yield* awaitSignal(firstUpdate, "Cursor SDK run activity before interrupt");
      yield* run.cancel;
    }
    if (input.interruptAfterToolStart === true) {
      yield* awaitSignal(toolStarted, "Cursor SDK tool-call-started before interrupt");
      // Synchronous tool-call-started cancellation crashes @cursor/sdk with AbortError (1.0.22, 1.0.31, 1.0.32); defer 10 ms.
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
export * from "./CursorAdapterV2-part2.testkit.ts";
