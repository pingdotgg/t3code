import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as CodexSchema from "effect-codex-app-server/schema";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  RuntimeRequestId,
  ServerSettingsError,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  readProviderReplayTranscript,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as CodexTestkit from "./Adapters/CodexAdapterV2.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerProviderReplay } from "./testkit/ProviderReplayHarness.ts";
import { materializeFixtureInput, CODEX_MODEL_SELECTION } from "./testkit/fixtures/shared.ts";
import { STREAM_RECOVERY_PROMPT } from "./StreamRecoveryPolicy.ts";

const decodeReplay = Schema.decodeUnknownEffect(CodexReplay.CodexAppServerReplayTranscript);
const decodeTurnStarted = Schema.decodeUnknownEffect(
  CodexSchema.ServerNotification__TurnStartedNotification,
);
const decodeTurnCompleted = Schema.decodeUnknownEffect(
  CodexSchema.ServerNotification__TurnCompletedNotification,
);
const decodeError = Schema.decodeUnknownEffect(CodexSchema.ServerNotification__ErrorNotification);
const decodeItemStarted = Schema.decodeUnknownEffect(
  CodexSchema.ServerNotification__ItemStartedNotification,
);
const decodeItemCompleted = Schema.decodeUnknownEffect(
  CodexSchema.ServerNotification__ItemCompletedNotification,
);

const PROMPT = "Inspect the saved fixture work and finish the report.";
const FAILURE = "stream disconnected before completion: stream closed before response.completed";
const nativeThreadId = "native-stream-recovery";
const makeTurn = (ordinal: number, status: string, error: unknown = null) => ({
  id: `native-stream-turn-${ordinal}`,
  items: [],
  itemsView: "notLoaded",
  status,
  error,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

// Replay the real native protocol through the adapter and SQLite outbox. No
// upstream request or classifier is involved, and no tool is executed by the fixture.
const makeTranscript = Effect.fn("makeStreamRecoveryTranscript")(function* (
  workspace: string,
  outcomes: ReadonlyArray<"failed" | "completed">,
  options: {
    readonly code?: string;
    readonly retryAttempt?: number;
    readonly retryStatus?: number;
    readonly omitRetry?: boolean;
    readonly retryProgress?: string;
    readonly duplicateTerminal?: boolean;
    readonly intermediateCode?: string;
    readonly safetyNotice?: boolean;
    readonly restartBetweenTurns?: boolean;
    readonly changedFailure?: boolean;
  } = {},
) {
  const original = yield* readProviderReplayTranscript(
    new URL("./testkit/fixtures/provider_thread_resume/codex_transcript.ndjson", import.meta.url),
  );
  const recorded = yield* decodeReplay(materializeReplayTranscriptWorkspace(original, workspace));
  const startResponse = recorded.entries.find(
    (entry) => entry.type === "emit_inbound" && entry.label === "thread/start",
  );
  assert(startResponse?.type === "emit_inbound" && Predicate.isObject(startResponse.frame));
  const result = startResponse.frame.result;
  assert(Predicate.isObject(result) && Predicate.isObject(result.thread));
  const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
    recorded.entries[0]!,
    {
      type: "emit_inbound",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/replay",
          codexHome: "/tmp/codex-replay",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    recorded.entries[2]!,
    recorded.entries.find(
      (entry) => entry.type === "expect_outbound" && entry.label === "thread/start",
    )!,
    {
      type: "emit_inbound",
      frame: {
        id: 2,
        result: {
          ...result,
          thread: {
            ...result.thread,
            id: nativeThreadId,
            sessionId: nativeThreadId,
            cwd: workspace,
          },
        },
      },
    },
  ];
  const expectedTurn = recorded.entries.find(
    (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
  );
  assert(
    expectedTurn?.type === "expect_outbound" &&
      Predicate.isObject(expectedTurn.frame) &&
      Predicate.isObject(expectedTurn.frame.params),
  );
  for (const [index, outcome] of outcomes.entries()) {
    const ordinal = index + 1;
    const id = options.restartBetweenTurns ? 3 : index + 3;
    if (index > 0 && options.restartBetweenTurns) {
      const resume = recorded.entries.find(
        (entry) => entry.type === "expect_outbound" && entry.label === "thread/resume",
      );
      assert(
        resume?.type === "expect_outbound" &&
          Predicate.isObject(resume.frame) &&
          Predicate.isObject(resume.frame.params),
      );
      entries.push(
        recorded.entries[0]!,
        {
          type: "emit_inbound",
          frame: {
            id: 1,
            result: {
              userAgent: "T3 Code/replay",
              codexHome: "/tmp/codex-replay",
              platformFamily: "unix",
              platformOs: "macos",
            },
          },
        },
        recorded.entries[2]!,
        {
          type: "expect_outbound",
          frame: {
            id: 2,
            method: "thread/resume",
            params: { ...resume.frame.params, threadId: nativeThreadId },
          },
        },
        {
          type: "emit_inbound",
          frame: {
            id: 2,
            result: {
              ...result,
              thread: {
                ...result.thread,
                id: nativeThreadId,
                sessionId: nativeThreadId,
                cwd: workspace,
              },
            },
          },
        },
      );
    }
    entries.push(
      {
        type: "expect_outbound",
        frame: {
          id,
          method: "turn/start",
          params: {
            ...expectedTurn.frame.params,
            threadId: nativeThreadId,
            input: [{ type: "text", text: index === 0 ? PROMPT : STREAM_RECOVERY_PROMPT }],
          },
        },
      },
      { type: "emit_inbound", frame: { id, result: { turn: makeTurn(ordinal, "inProgress") } } },
      {
        type: "emit_inbound",
        frame: {
          method: "turn/started",
          params: { threadId: nativeThreadId, turn: makeTurn(ordinal, "inProgress") },
        },
      },
      {
        type: "emit_inbound",
        frame: {
          method: "item/started",
          params: {
            startedAtMs: 0,
            threadId: nativeThreadId,
            turnId: `native-stream-turn-${ordinal}`,
            item: {
              type: "agentMessage",
              id: `saved-${ordinal}`,
              text: "Saved partial work.",
              phase: "commentary",
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          },
        },
      },
      {
        type: "emit_inbound",
        frame: {
          method: "item/completed",
          params: {
            completedAtMs: 0,
            threadId: nativeThreadId,
            turnId: `native-stream-turn-${ordinal}`,
            item: {
              type: "agentMessage",
              id: `saved-${ordinal}`,
              text: "Saved partial work.",
              phase: "commentary",
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          },
        },
      },
    );
    if (options.safetyNotice)
      entries.push({
        type: "emit_inbound",
        frame: {
          method: "model/safetyBuffering/updated",
          params: {
            threadId: nativeThreadId,
            turnId: `native-stream-turn-${ordinal}`,
            model: CODEX_MODEL_SELECTION.model,
            reasons: ["user_risk"],
            useCases: ["cyber"],
            showBufferingUi: true,
          },
        },
      });
    if (options.intermediateCode)
      entries.push({
        type: "emit_inbound",
        frame: {
          method: "error",
          params: {
            threadId: nativeThreadId,
            turnId: `native-stream-turn-${ordinal}`,
            willRetry: true,
            error: {
              message: "Earlier failure.",
              codexErrorInfo: options.intermediateCode,
              additionalDetails: null,
            },
          },
        },
      });
    if (outcome === "failed")
      entries.push(
        {
          type: "emit_inbound",
          frame: {
            method: "error",
            params: {
              threadId: nativeThreadId,
              turnId: `native-stream-turn-${ordinal}`,
              willRetry: true,
              error: {
                message: options.retryProgress ?? `Reconnecting... ${options.retryAttempt ?? 5}/5`,
                additionalDetails: FAILURE,
                codexErrorInfo: {
                  responseStreamDisconnected: { httpStatusCode: options.retryStatus ?? null },
                },
              },
            },
          },
        },
        {
          type: "emit_inbound",
          frame: {
            method: "error",
            params: {
              threadId: nativeThreadId,
              turnId: `native-stream-turn-${ordinal}`,
              willRetry: false,
              error: {
                message: options.changedFailure ? "A different terminal failure." : FAILURE,
                additionalDetails: null,
                codexErrorInfo: options.code ?? "other",
              },
            },
          },
        },
      );
    entries.push({
      type: "emit_inbound",
      frame: {
        method: "turn/completed",
        params: {
          threadId: nativeThreadId,
          turn: makeTurn(
            ordinal,
            outcome,
            outcome === "failed"
              ? {
                  message: options.changedFailure ? "A different terminal failure." : FAILURE,
                  additionalDetails: null,
                  codexErrorInfo: options.code ?? "other",
                }
              : null,
          ),
        },
      },
    });
  }
  if (options.omitRetry) {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (
        entry.type === "emit_inbound" &&
        Predicate.isObject(entry.frame) &&
        entry.frame.method === "error" &&
        Predicate.isObject(entry.frame.params) &&
        entry.frame.params.willRetry === true
      )
        entries.splice(index, 1);
    }
  }
  if (options.duplicateTerminal) {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (
        entry.type === "emit_inbound" &&
        Predicate.isObject(entry.frame) &&
        entry.frame.method === "turn/completed"
      )
        entries.splice(index + 1, 0, entry);
    }
  }
  for (const entry of entries) {
    if (entry.type !== "emit_inbound" || !Predicate.isObject(entry.frame)) continue;
    const frame = entry.frame;
    if (frame.method === "turn/started") yield* decodeTurnStarted(frame.params);
    if (frame.method === "turn/completed") yield* decodeTurnCompleted(frame.params);
    if (frame.method === "error") yield* decodeError(frame.params);
    if (frame.method === "item/started") yield* decodeItemStarted(frame.params);
    if (frame.method === "item/completed") yield* decodeItemCompleted(frame.params);
  }
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: recorded.version,
    scenario: "stream-recovery",
    entries,
  } satisfies CodexReplay.CodexAppServerReplayTranscript;
});

const watchRun = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  ordinal: number,
  status: OrchestrationV2Run["status"],
) =>
  orchestrator.streamStoredEvents.pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "run.updated" &&
        stored.event.payload.ordinal === ordinal &&
        stored.event.payload.status === status,
    ),
    Stream.runHead,
    Effect.forkScoped,
  );

const withReplay = Effect.fn("withStreamRecoveryReplay")(function* (
  outcomes: ReadonlyArray<"failed" | "completed">,
  verify: (input: {
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly worker: EffectWorker.OrchestrationEffectWorkerV2["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
    readonly events: EventSink.EventSinkV2["Service"];
    readonly outbox: EffectOutbox.EffectOutboxV2["Service"];
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    void,
    | Orchestrator.OrchestratorV2Error
    | EffectWorker.OrchestrationEffectWorkerError
    | ServerSettingsError
    | EventSink.EventSinkWriteError
    | EventSink.EventSinkStreamError
    | EffectOutbox.EffectOutboxError,
    Scope.Scope
  >,
  options: Parameters<typeof makeTranscript>[2] & {
    readonly enabled?: boolean;
    readonly runEffectWorker?: boolean;
  } = {},
) {
  const workspace = yield* checkpointWorkspace("stream-recovery");
  const transcript = yield* makeTranscript(workspace, outcomes, options);
  const materialized = yield* materializeFixtureInput({
    scenario: "stream-recovery",
    fixtureInput: { steps: [{ type: "message", text: PROMPT }] },
    driver: ProviderDriverKind.make("codex"),
    modelSelection: CODEX_MODEL_SELECTION,
  });
  const databaseLayer = SqlitePersistence.layerMemory;
  const threadId = materialized.projectionThreadIds[0]!;
  const driver = yield* CodexReplay.makeReplayDriver(transcript);
  const harness = {
    ...CodexTestkit.CodexOrchestratorReplayHarness,
    makeProviderAdapterRegistryLayer: () => CodexTestkit.layer({ transcript, driver }),
  };
  yield* Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const events = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      for (const command of materialized.commands) yield* orchestrator.dispatch(command);
      const failed = yield* watchRun(
        orchestrator,
        1,
        outcomes[0] === "failed" ? "failed" : "completed",
      );
      if (options.runEffectWorker === false) yield* worker.drain();
      assert.isTrue(Option.isSome(yield* Fiber.join(failed)));
      assert.isNull((yield* Ref.get(driver.state)).failure);
      yield* verify({ orchestrator, worker, settings, events, outbox, threadId });
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerProviderReplay(
            {
              name: "stream-recovery",
              transcript,
              commands: [],
              runtimePolicyOverride: { cwd: workspace },
            },
            harness,
            {
              databaseLayer,
              runEffectWorker: options.runEffectWorker ?? true,
              recoverCodexStreamFailures: options.enabled ?? true,
            },
          ),
          EffectOutbox.layer.pipe(Layer.provide(databaseLayer)),
        ),
      ),
    ),
  );
});

it.effect("continues the same native conversation once after delay and preserves saved work", () =>
  withReplay(
    ["failed", "completed"],
    ({ orchestrator, worker, threadId }) =>
      Effect.gen(function* () {
        const initial = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(initial.runs[0]?.streamRecovery?.state, "pending");
        assert.equal(initial.turnItems.find((item) => item.type === "error")?.type, "error");
        yield* TestClock.adjust("29 seconds");
        yield* worker.drain();
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        yield* TestClock.adjust("1 second");
        const completed = yield* watchRun(orchestrator, 2, "completed");
        yield* worker.drain();
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
        assert.isTrue(Option.isSome(yield* Fiber.join(completed)));
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(final.runs, 2);
        assert.equal(final.runs[1]?.providerThreadId, initial.runs[0]?.providerThreadId);
        assert.equal(final.providerThreads[0]?.nativeThreadRef?.nativeId, nativeThreadId);
        assert.equal(final.runs[1]?.streamRecoveryAttempt, 1);
        assert.equal(final.runs[1]?.streamContinuationOfRunId, initial.runs[0]?.id);
        assert.isTrue(
          final.messages.some(
            (message) =>
              message.text === "Saved partial work." && message.runId === initial.runs[0]?.id,
          ),
        );
        assert.isTrue(
          final.messages.some(
            (message) => message.text === STREAM_RECOVERY_PROMPT && message.createdBy === "agent",
          ),
        );
        for (const commandId of [
          CommandId.make(`command:stream-recovery:${initial.runs[0]!.id}`),
          CommandId.make("duplicate-client-recovery"),
        ]) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId,
            threadId,
            messageId: MessageId.make(`message:stream-recovery:${initial.runs[0]!.id}`),
            streamContinuationOfRunId: initial.runs[0]!.id,
            streamRecoveryGeneration: 0,
            text: STREAM_RECOVERY_PROMPT,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "server",
          });
        }
        yield* TestClock.adjust("10 minutes");
        yield* worker.drain();
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }),
    { duplicateTerminal: true },
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect.each([
  { enabled: false },
  { retryAttempt: 1 },
  { omitRetry: true },
  { retryProgress: "Retrying native request." },
  { code: "cyberPolicy" },
  { code: "misalignmentPolicyViolation" },
  { code: "rateLimitExceeded" },
  { code: "contextWindowExceeded" },
  { code: "unauthorized" },
  { retryStatus: 529 },
  { retryStatus: 429 },
  { retryStatus: 503 },
  { changedFailure: true },
  { intermediateCode: "cyberPolicy" },
  { intermediateCode: "misalignmentPolicyViolation" },
  { code: "serverOverloaded" },
])("leaves excluded native failure stopped: %j", (options) =>
  withReplay(
    ["failed"],
    ({ orchestrator, worker, threadId }) =>
      Effect.gen(function* () {
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.streamRecovery,
        );
        yield* TestClock.adjust("10 minutes");
        yield* worker.drain();
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      }),
    options,
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect.each([
  "stop",
  "settle",
  "snooze",
  "archive",
  "delete",
  "disable",
  "new-message",
] as const)("invalidates a pending attempt when %s wins", (change) =>
  withReplay(["failed"], ({ orchestrator, worker, settings, threadId }) =>
    Effect.gen(function* () {
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* TestClock.adjust("1 second");
      if (change === "disable") {
        yield* settings.updateSettings({ recoverCodexStreamFailures: false });
        // Re-enabling must not restore an old opportunity.
        yield* settings.updateSettings({ recoverCodexStreamFailures: true });
      } else if (change === "new-message") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("new-instruction"),
          threadId,
          messageId: MessageId.make("new-instruction"),
          text: "New instruction takes priority.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      } else {
        yield* orchestrator.dispatch(
          change === "stop"
            ? { type: "thread.stop", threadId, commandId: CommandId.make(`change:${change}`) }
            : change === "snooze"
              ? {
                  type: "thread.snooze",
                  threadId,
                  commandId: CommandId.make(`change:${change}`),
                  snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
                }
              : {
                  type: `thread.${change}`,
                  threadId,
                  commandId: CommandId.make(`change:${change}`),
                },
        );
      }
      yield* TestClock.adjust("30 seconds");
      // Exercise the serialized timer dispatch directly: no provider turn is needed to reject a stale attempt.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        threadId,
        commandId: CommandId.make(`stale-recovery:${change}`),
        messageId: MessageId.make(`stale-recovery:${change}`),
        streamContinuationOfRunId: source.id,
        streamRecoveryGeneration: 0,
        text: STREAM_RECOVERY_PROMPT,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      });
      const final = yield* orchestrator.getThreadProjection(threadId);
      assert.isFalse(final.runs.some((run) => run.streamContinuationOfRunId === source.id));
      assert.equal(final.runs[0]?.streamRecovery?.state, "cancelled");
      if (change !== "new-message") yield* worker.drain();
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect("preserves the finite recovery budget and due work across two server restarts", () =>
  Effect.gen(function* () {
    const workspace = yield* checkpointWorkspace("stream-recovery-restarts");
    const transcript = yield* makeTranscript(workspace, ["failed", "failed", "failed"], {
      restartBetweenTurns: true,
    });
    const driver = yield* CodexReplay.makeReplayDriver(transcript);
    const harness = {
      ...CodexTestkit.CodexOrchestratorReplayHarness,
      makeProviderAdapterRegistryLayer: () => CodexTestkit.layer({ transcript, driver }),
    };
    const materialized = yield* materializeFixtureInput({
      scenario: "stream-recovery-restarts",
      fixtureInput: { steps: [{ type: "message", text: PROMPT }] },
      driver: ProviderDriverKind.make("codex"),
      modelSelection: CODEX_MODEL_SELECTION,
    });
    const threadId = materialized.projectionThreadIds[0]!;
    const databaseLayer = SqlitePersistence.layerFromPath(`${workspace}/state.sqlite`).pipe(
      Layer.provide(NodeServices.layer),
    );
    for (const phase of [1, 2, 3]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          if (phase === 1)
            for (const command of materialized.commands) yield* orchestrator.dispatch(command);
          else {
            const before = yield* orchestrator.getThreadProjection(threadId);
            assert.lengthOf(before.runs, phase - 1);
            assert.equal(before.runs.at(-1)?.streamRecovery?.state, "pending");
            yield* TestClock.adjust(phase === 2 ? "30 seconds" : "60 seconds");
          }
          const failed = yield* watchRun(orchestrator, phase, "failed");
          yield* worker.drain();
          assert.isTrue(Option.isSome(yield* Fiber.join(failed)));
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(projection.runs, phase);
          assert.equal(projection.runs.at(-1)?.streamRecoveryAttempt ?? 0, phase - 1);
          assert.equal(projection.providerThreads[0]?.nativeThreadRef?.nativeId, nativeThreadId);
          assert.isNull((yield* Ref.get(driver.state)).failure);
          if (phase === 3) {
            assert.equal(projection.runs.at(-1)?.streamRecovery?.state, "exhausted");
            yield* TestClock.adjust("10 minutes");
            yield* worker.drain();
            assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 3);
          }
        }).pipe(
          Effect.provide(
            layerProviderReplay(
              {
                name: "stream-recovery-restarts",
                transcript,
                commands: [],
                runtimePolicyOverride: { cwd: workspace },
              },
              harness,
              {
                databaseLayer,
                runEffectWorker: false,
                recoverOnStartup: phase > 1,
                recoverCodexStreamFailures: true,
              },
            ),
          ),
        ),
      );
    }
    assert.equal((yield* Ref.get(driver.state)).cursor, transcript.entries.length);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect.each(["command", "user_input"] as const)(
  "keeps pending %s authoritative over a recovery timer",
  (kind) =>
    withReplay(["failed"], ({ orchestrator, worker, events, threadId }) =>
      Effect.gen(function* () {
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const source = projection.runs[0]!;
        const turn = projection.providerTurns[0]!;
        const now = yield* DateTime.now;
        yield* events.write({
          events: [
            {
              id: EventId.make(`pending:${kind}`),
              type: "runtime-request.updated",
              threadId,
              runId: source.id,
              occurredAt: now,
              payload: {
                id: RuntimeRequestId.make(`request:${kind}`),
                nodeId: source.rootNodeId!,
                providerTurnId: turn.id,
                nativeRequestRef: null,
                kind,
                status: "pending",
                responseCapability:
                  kind === "command"
                    ? {
                        type: "live",
                        providerSessionId: projection.providerThreads[0]!.providerSessionId!,
                      }
                    : { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
          ],
        });
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain();
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(final.runs, 1);
        assert.equal(final.runs[0]?.streamRecovery?.state, "cancelled");
        assert.equal(final.runtimeRequests[0]?.status, "pending");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect("does not schedule recovery for success or safety-buffering information", () =>
  withReplay(
    ["completed"],
    ({ orchestrator, worker, threadId }) =>
      Effect.gen(function* () {
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.streamRecovery,
        );
        yield* TestClock.adjust("10 minutes");
        yield* worker.drain();
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      }),
    { safetyNotice: true },
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect.each([
  { first: "archive", reverse: "unarchive" },
  { first: "settle", reverse: "unsettle" },
  { first: "snooze", reverse: "unsnooze" },
] as const)(
  "keeps recovery cancelled when %s is reversed in the same clock tick",
  ({ first, reverse }) =>
    withReplay(["failed"], ({ orchestrator, worker, threadId }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch(
          first === "snooze"
            ? {
                type: "thread.snooze",
                threadId,
                commandId: CommandId.make("cancel-intent"),
                snoozedUntil: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
              }
            : { type: `thread.${first}`, threadId, commandId: CommandId.make("cancel-intent") },
        );
        yield* orchestrator.dispatch(
          reverse === "unarchive"
            ? { type: "thread.unarchive", threadId, commandId: CommandId.make("reverse-intent") }
            : {
                type: `thread.${reverse}`,
                threadId,
                commandId: CommandId.make("reverse-intent"),
                reason: "user",
              },
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.streamRecovery?.state,
          "cancelled",
        );
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain();
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect.each(
  (["model", "options", "runtime", "interaction", "provider"] as const).flatMap((configuration) => [
    { configuration, reverse: false },
    { configuration, reverse: true },
  ]),
)(
  "keeps configuration changes authoritative in the failure clock tick: %j",
  ({ configuration, reverse }) =>
    withReplay(["failed"], ({ orchestrator, worker, threadId }) =>
      Effect.gen(function* () {
        const original = (yield* orchestrator.getThreadProjection(threadId)).thread;
        for (const restore of reverse ? [false, true] : [false]) {
          const commandId = CommandId.make(`configuration:${configuration}:${restore}`);
          const modelSelection = restore
            ? original.modelSelection
            : configuration === "options"
              ? { ...original.modelSelection, options: [{ id: "effort", value: "low" }] }
              : { ...original.modelSelection, model: "gpt-5.4" };
          if (configuration === "runtime")
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId,
              threadId,
              runtimeMode: restore ? original.runtimeMode : "approval-required",
            });
          else if (configuration === "interaction")
            yield* orchestrator.dispatch({
              type: "thread.interaction-mode.set",
              commandId,
              threadId,
              interactionMode: restore ? original.interactionMode : "plan",
            });
          else
            yield* orchestrator.dispatch({
              type: configuration === "provider" ? "provider.switch" : "thread.model-selection.set",
              commandId,
              threadId,
              modelSelection,
            });
          const current = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(current.runs[0]?.streamRecovery?.state, "cancelled");
          if (configuration === "runtime")
            assert.equal(
              current.thread.runtimeMode,
              restore ? original.runtimeMode : "approval-required",
            );
          else if (configuration === "interaction")
            assert.equal(
              current.thread.interactionMode,
              restore ? original.interactionMode : "plan",
            );
          else assert.deepEqual(current.thread.modelSelection, modelSelection);
        }
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain();
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(final.runs, 1);
        assert.equal(final.runs[0]?.streamRecovery?.state, "cancelled");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect("preserves the receipt conflict tag for a stream continuation", () =>
  withReplay(["failed"], ({ orchestrator, threadId }) =>
    Effect.gen(function* () {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const otherThreadId = ThreadId.make("thread:stream-receipt-other");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-other-receipt-thread"),
        threadId: otherThreadId,
        projectId: projection.thread.projectId,
        title: "Other receipt thread",
        modelSelection: projection.thread.modelSelection,
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const commandId = CommandId.make("stream-receipt-conflict");
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId,
        threadId,
        visitedAt: DateTime.formatIso(projection.thread.updatedAt),
      });
      const result = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId,
          threadId: otherThreadId,
          messageId: MessageId.make("stream-receipt-conflict"),
          streamContinuationOfRunId: projection.runs[0]!.id,
          streamRecoveryGeneration: 0,
          text: STREAM_RECOVERY_PROMPT,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.result);
      const error = result._tag === "Failure" ? result.failure : undefined;
      assert(error !== undefined);
      assert.equal(error._tag, "OrchestratorCommandIdConflictError");
      if (error._tag === "OrchestratorCommandIdConflictError") {
        assert.equal(error.receiptThreadId, threadId);
        assert.equal(error.commandThreadId, otherThreadId);
      }
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect("preserves the previously rejected receipt tag for a stream continuation", () =>
  withReplay(["failed"], ({ orchestrator, threadId }) =>
    Effect.gen(function* () {
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const commandId = CommandId.make("stream-receipt-rejected");
      const first = yield* orchestrator
        .dispatch({
          type: "thread.archive",
          commandId,
          threadId: ThreadId.make("thread:missing-stream-receipt"),
        })
        .pipe(Effect.result);
      assert.equal(first._tag, "Failure");
      if (first._tag === "Failure") assert.equal(first.failure._tag, "OrchestratorProjectionError");
      const result = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("stream-receipt-rejected"),
          streamContinuationOfRunId: source.id,
          streamRecoveryGeneration: 0,
          text: STREAM_RECOVERY_PROMPT,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.result);
      const error = result._tag === "Failure" ? result.failure : undefined;
      assert(error !== undefined);
      assert.equal(error._tag, "OrchestratorCommandPreviouslyRejectedError");
      if (error._tag === "OrchestratorCommandPreviouslyRejectedError")
        assert.equal(error.commandId, commandId);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.streamRecovery?.state,
        "pending",
      );
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect("wraps a settings snapshot failure with the immediate settings cause", () =>
  withReplay(["failed"], ({ orchestrator, settings, threadId }) =>
    Effect.gen(function* () {
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const snapshotFailure = new ServerSettingsError({
        operation: "read-file",
        settingsPath: "/tmp/fixture-settings.json",
      });
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = settings.withSettingsSnapshot;
          // Inject failure only at the external settings transaction boundary.
          Object.assign(settings, { withSettingsSnapshot: () => Effect.fail(snapshotFailure) });
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            const commandId = CommandId.make("stream-settings-snapshot-failure");
            const result = yield* orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId,
                threadId,
                messageId: MessageId.make("stream-settings-snapshot-failure"),
                streamContinuationOfRunId: source.id,
                streamRecoveryGeneration: 0,
                text: STREAM_RECOVERY_PROMPT,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "agent",
                creationSource: "server",
              })
              .pipe(Effect.result);
            const error = result._tag === "Failure" ? result.failure : undefined;
            assert(error !== undefined);
            assert.equal(error._tag, "OrchestratorDispatchError");
            if (error._tag === "OrchestratorDispatchError") {
              assert.equal(error.commandId, commandId);
              assert.strictEqual(error.cause, snapshotFailure);
            }
          }),
        (previous) =>
          Effect.sync(() => Object.assign(settings, { withSettingsSnapshot: previous })),
      );
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect(
  "persists cleanup under its lease and keeps failure evidence through process loss and Stop",
  () =>
    withReplay(
      ["failed"],
      ({ orchestrator, outbox, worker, threadId }) =>
        Effect.gen(function* () {
          const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
          const effectId = `effect:stream-recovery:${runId}`;
          yield* TestClock.adjust("30 seconds");
          const claimed = yield* outbox.claimNext({
            workerId: "phase-owner",
            leaseDurationMs: 30_000,
          });
          assert(claimed._tag === "Some");
          assert.equal(claimed.value.id, effectId);
          assert.isFalse(
            yield* outbox.retry({
              effectId,
              workerId: "wrong-owner",
              error: "must not persist",
              delayMs: 0,
              streamRecoveryCleanupOnly: true,
            }),
          );
          const unchanged = yield* outbox.get(effectId);
          assert(
            unchanged._tag === "Some" &&
              unchanged.value.request.type === "provider-runtime.recover-stream",
          );
          assert.isUndefined(unchanged.value.request.cleanupOnly);
          assert.isTrue(
            yield* outbox.retry({
              effectId,
              workerId: "phase-owner",
              error: "Original continuation write failed.",
              delayMs: 0,
              streamRecoveryCleanupOnly: true,
            }),
          );
          const cleanup = yield* outbox.claimNext({
            workerId: "cleanup-owner",
            leaseDurationMs: 30_000,
          });
          assert(
            cleanup._tag === "Some" &&
              cleanup.value.request.type === "provider-runtime.recover-stream",
          );
          assert.isTrue(cleanup.value.request.cleanupOnly);
          assert.equal(cleanup.value.attemptCount, 2);
          assert.equal(cleanup.value.lastError, "Original continuation write failed.");
          yield* outbox.reconcileAfterProcessLoss;
          const restored = yield* outbox.get(effectId);
          assert(
            restored._tag === "Some" &&
              restored.value.request.type === "provider-runtime.recover-stream",
          );
          assert.isTrue(restored.value.request.cleanupOnly);
          assert.equal(restored.value.attemptCount, 2);
          assert.equal(restored.value.lastError, cleanup.value.lastError);
          const reClaimed = yield* outbox.claimNext({
            workerId: "after-restart",
            leaseDurationMs: 30_000,
          });
          assert(reClaimed._tag === "Some");
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-cleanup-phase"),
            threadId,
          });
          assert.isFalse(
            yield* outbox.retry({
              effectId,
              workerId: "after-restart",
              error: "late cleanup failure",
              delayMs: 0,
              streamRecoveryCleanupOnly: true,
            }),
          );
          const stopped = yield* outbox.get(effectId);
          assert(stopped._tag === "Some");
          assert.equal(stopped.value.status, "cancelled");
          yield* TestClock.adjust("10 minutes");
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.runs[0]?.streamRecovery?.state, "cancelled");
          assert.lengthOf(projection.runs, 1);
        }),
      { runEffectWorker: false },
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);

it.effect(
  "cleans a spent recovery after process loss even when its phase write never committed",
  () =>
    withReplay(
      ["failed"],
      ({ orchestrator, outbox, worker, threadId }) =>
        Effect.gen(function* () {
          const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
          const effectId = `effect:stream-recovery:${runId}`;
          yield* TestClock.adjust("30 seconds");
          // Reconstruct a spent lease whose terminal phase update was lost. The
          // delegated fixture separately proves five actual failed dispatches.
          for (let attempt = 1; attempt <= 5; attempt += 1) {
            const claimed = yield* outbox.claimNext({
              workerId: "crashed-recovery",
              leaseDurationMs: 30_000,
            });
            assert(claimed._tag === "Some");
            assert.equal(claimed.value.id, effectId);
            assert.equal(claimed.value.attemptCount, attempt);
            if (attempt < 5)
              yield* outbox.retry({
                effectId,
                workerId: "crashed-recovery",
                error: "Spent continuation failure.",
                delayMs: 0,
              });
          }
          yield* outbox.reconcileAfterProcessLoss;
          const restored = yield* outbox.get(effectId);
          assert(
            restored._tag === "Some" &&
              restored.value.request.type === "provider-runtime.recover-stream",
          );
          assert.equal(restored.value.attemptCount, 5);
          assert.isUndefined(restored.value.request.cleanupOnly);
          assert.equal(yield* worker.drain(1), 1);
          const settled = yield* outbox.get(effectId);
          assert(settled._tag === "Some");
          assert.equal(settled.value.status, "failed");
          assert.equal(settled.value.attemptCount, 6);
          assert.equal(settled.value.lastError, "Spent continuation failure.");
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.runs[0]?.streamRecovery?.state, "cancelled");
          assert.lengthOf(projection.runs, 1);
          assert.isFalse(
            projection.messages.some(
              (message) => message.id === MessageId.make(`message:stream-recovery:${runId}`),
            ),
          );
        }),
      { runEffectWorker: false },
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
);
