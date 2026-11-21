import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  CHAT_REPLIES_DISPLAY_MODE,
  displayNote,
  NORMAL_DISPLAY,
  NORMAL_DISPLAY_MODE,
} from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../../orchestration-v2/testkit/fixtures/shared.ts";
import { outputInstructions } from "../../orchestration-v2/runOutput.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as DisplayModeWrap from "./DisplayModeWrap.ts";
import { layerNoProviders } from "./DisplayModeWrap.testkit.ts";

const threadId = ThreadId.make("thread:display-wrap-context");
const projectId = ProjectId.make("project:display-wrap-context");

/**
 * A provider that sends one message to the user and finishes each turn at once. It can refuse a
 * resume or a start, and it can run an effect while it takes in a handoff's history.
 */
const makeAdapter = (input: {
  readonly driver: ProviderDriverKind;
  readonly selection: ModelSelection;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly attempts: Ref.Ref<ReadonlyArray<string>>;
  readonly failResume: Ref.Ref<boolean>;
  readonly failStart: Ref.Ref<boolean>;
  readonly injected: Ref.Ref<ReadonlyArray<string>>;
  readonly duringInjection: Ref.Ref<Effect.Effect<void>>;
}): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const { driver } = input;
  const refused = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
  let generation = 0;
  return {
    instanceId: input.selection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const newThread = (appThreadId: ThreadId) => {
          generation += 1;
          const nativeId = `${driver}:${appThreadId}:${generation}`;
          return {
            id: ProviderThreadId.make(`provider-thread:${nativeId}`),
            driver,
            providerInstanceId: input.selection.instanceId,
            providerSessionId: sessionInput.providerSessionId,
            appThreadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId, strength: "strong" as const },
            nativeConversationHeadRef: null,
            status: "idle" as const,
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            contextUsage: null,
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          };
        };
        return {
          instanceId: input.selection.instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId: input.selection.instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
            model: input.selection.model,
            capabilities: input.capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) => Effect.sync(() => newThread(threadInput.threadId)),
          resumeThread: ({ providerThread }) =>
            Ref.getAndSet(input.failResume, false).pipe(
              Effect.flatMap((fail) =>
                fail ? refused("native resume failed") : Effect.succeed(providerThread),
              ),
            ),
          injectHistory: (history) =>
            Ref.update(input.injected, (texts) => [
              ...texts,
              ...history.messages.map((message) => message.text),
            ]).pipe(
              Effect.andThen(Ref.get(input.duringInjection)),
              Effect.flatten,
              Effect.as(true),
            ),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const { commandNote, message } = turnInput;
              yield* Ref.update(input.attempts, (texts) => [
                ...texts,
                commandNote === undefined ? message.text : `${commandNote.text}|${message.text}`,
              ]);
              if (yield* Ref.getAndSet(input.failStart, false)) {
                return yield* refused("turn start refused");
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`turn:${driver}:${turnInput.runOrdinal}`);
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native-turn:${driver}:${turnInput.runOrdinal}`,
                    strength: "strong",
                  },
                  ordinal: turnInput.runOrdinal,
                  status: "completed",
                  startedAt: eventTime,
                  completedAt: eventTime,
                },
              });
              yield* PubSub.publish(events, {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`turn-item:${driver}:${turnInput.runOrdinal}:send`),
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turnInput.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: eventTime,
                  completedAt: eventTime,
                  updatedAt: eventTime,
                  type: "dynamic_tool",
                  toolName: "mcp__t3-code__send_to_user",
                  input: { text: `Sent in run ${turnInput.runOrdinal}` },
                },
              });
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => refused("unused"),
          rollbackThread: ({ providerThread }) =>
            Effect.succeed({
              providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            }),
          forkThread: ({ targetThreadId }) => Effect.sync(() => newThread(targetThreadId)),
        };
      }),
  };
};

/** Runs `body` with a Chat mode thread on Claude and Codex, and returns which attempts had the note. */
const notesPerAttempt = (
  name: string,
  body: (input: {
    readonly send: (
      ordinal: number,
      selection?: ModelSelection,
      text?: string,
      outputSchema?: Readonly<Record<string, Schema.Json>>,
    ) => Effect.Effect<void>;
    readonly failResume: Ref.Ref<boolean>;
    readonly failStart: Ref.Ref<boolean>;
    readonly injected: Ref.Ref<ReadonlyArray<string>>;
    readonly duringInjection: Ref.Ref<Effect.Effect<void>>;
    readonly stopLatestRun: Effect.Effect<void>;
    readonly toldModeAfterStart: Effect.Effect<string | undefined>;
    readonly rollBackToFirstCheckpoint: Effect.Effect<void>;
    /** Forks the thread at its latest run, sends a typed message in the fork, and returns its text. */
    readonly sendInFork: Effect.Effect<string>;
    readonly switchMode: (modeId: string | null) => Effect.Effect<void>;
    readonly lastAttempt: Effect.Effect<string>;
  }) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make<ReadonlyArray<string>>([]);
    const failResume = yield* Ref.make(false);
    const failStart = yield* Ref.make(false);
    const injected = yield* Ref.make<ReadonlyArray<string>>([]);
    const duringInjection = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const shared = { attempts, failResume, failStart, injected, duringInjection };
    const registry = ProviderAdapterRegistry.layerFromAdapters([
      makeAdapter({
        ...shared,
        driver: ProviderDriverKind.make("claudeAgent"),
        selection: CLAUDE_MODEL_SELECTION,
        capabilities: ClaudeProviderCapabilitiesV2,
      }),
      makeAdapter({
        ...shared,
        driver: ProviderDriverKind.make("codex"),
        selection: CODEX_MODEL_SELECTION,
        capabilities: CodexProviderCapabilitiesV2,
      }),
    ]);
    const cwd = yield* checkpointWorkspace(name);
    const wrapper = DisplayModeWrap.layer.pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provideMerge(
        ServerSettings.layerTest({
          threadDisplayModes: { [threadId]: CHAT_REPLIES_DISPLAY_MODE.id },
        }),
      ),
      Layer.provide(layerNoProviders),
    );
    // The harness has its own settings, so the wrapper's are reached from outside it.
    const wrapperSettings = yield* Ref.make<ServerSettings.ServerSettingsService["Service"] | null>(
      null,
    );
    const switchMode = (modeId: string | null) =>
      Ref.get(wrapperSettings).pipe(
        Effect.flatMap((settings) =>
          settings!.updateSettings({ threadDisplayModes: { [threadId]: modeId } }),
        ),
        Effect.orDie,
      );
    const lastAttempt = Ref.get(attempts).pipe(Effect.map((texts) => texts.at(-1) ?? ""));
    const run = Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("display-wrap-context:create"),
        threadId,
        projectId,
        createdBy: "user",
        creationSource: "web",
        title: "Display mode context",
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const send = Effect.fn("send")(function* (
        ordinal: number,
        selection: ModelSelection = CLAUDE_MODEL_SELECTION,
        text = `Request ${ordinal}`,
        outputSchema?: Readonly<Record<string, Schema.Json>>,
      ) {
        const providerSessionId = (yield* orchestrator.getThreadProjection(
          threadId,
        )).providerThreads.at(-1)?.providerSessionId;
        if (providerSessionId != null) {
          yield* orchestrator.dispatch({
            type: "provider-session.detach",
            commandId: CommandId.make(`display-wrap-context:detach:${ordinal}`),
            threadId,
            providerSessionId,
          });
          yield* worker.drain();
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`display-wrap-context:${ordinal}`),
          threadId,
          messageId: MessageId.make(`message:display-wrap-context:${ordinal}`),
          createdBy: "user",
          creationSource: "web",
          text,
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
          ...(outputSchema === undefined ? {} : { outputSchema }),
        });
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.payload.ordinal === ordinal &&
              ["completed", "failed", "interrupted"].includes(event.payload.status),
          ),
          Stream.runHead,
        );
        yield* worker.drain();
      }, Effect.orDie);
      // A stop command also cancels the start's fiber, so this changes only the status that the start checks.
      const eventSink = yield* EventSink.EventSinkV2;
      const stopLatestRun = Effect.gen(function* () {
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`display-wrap-context:stopped:${run.id}`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "interrupted", completedAt: now },
            },
          ],
        });
      }).pipe(Effect.orDie);
      // The run's status can settle before the start returns, and the start's outbox row settles after it.
      const sql = yield* SqlClient.SqlClient;
      const toldModeAfterStart = Effect.gen(function* () {
        yield* sql<{ readonly open: number }>`
          SELECT COUNT(*) AS open FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.start'
            AND status IN ('pending', 'running')
        `.pipe(Effect.repeat({ until: (rows) => rows[0]?.open === 0 }));
        const told = yield* sql<{ readonly mode_id: string }>`
          SELECT mode_id FROM fork_display_mode_told WHERE thread_id = ${threadId}
        `;
        return told[0]?.mode_id;
      }).pipe(Effect.orDie);
      const rollBackToFirstCheckpoint = Effect.gen(function* () {
        const checkpoint = (yield* orchestrator.getThreadProjection(threadId)).checkpoints.toSorted(
          (a, b) => a.ordinalWithinScope - b.ordinalWithinScope,
        )[0]!;
        yield* orchestrator.dispatch({
          type: "checkpoint.rollback",
          restoreFiles: false,
          commandId: CommandId.make("display-wrap-context:rollback"),
          threadId,
          scopeId: checkpoint.scopeId,
          checkpointId: checkpoint.id,
        });
        yield* worker.drain();
      }).pipe(Effect.orDie);
      const forkId = ThreadId.make("thread:display-wrap-context:fork");
      const sendInFork = Effect.gen(function* () {
        yield* orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("display-wrap-context:fork"),
          sourceThreadId: threadId,
          targetThreadId: forkId,
          sourcePoint: { type: "latest_stable" },
          title: "Fork",
        });
        yield* worker.drain();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("display-wrap-context:fork-message"),
          threadId: forkId,
          messageId: MessageId.make("message:display-wrap-context:fork"),
          createdBy: "user",
          creationSource: "web",
          text: "Request in the fork",
          attachments: [],
          modelSelection: CLAUDE_MODEL_SELECTION,
          dispatchMode: { type: "start_immediately" },
        });
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.threadId === forkId &&
              ["completed", "failed", "interrupted"].includes(event.payload.status),
          ),
          Stream.runHead,
        );
        yield* worker.drain();
        return (yield* Ref.get(attempts)).at(-1) ?? "";
      }).pipe(Effect.orDie);
      yield* body({
        send,
        failResume,
        failStart,
        injected,
        duringInjection,
        stopLatestRun,
        toldModeAfterStart,
        rollBackToFirstCheckpoint,
        sendInFork,
        switchMode,
        lastAttempt,
      });
    });
    yield* SqlClient.SqlClient.pipe(
      Effect.tap(() =>
        ServerSettings.ServerSettingsService.pipe(
          Effect.flatMap((settings) => Ref.set(wrapperSettings, settings)),
        ),
      ),
      Effect.flatMap((sql) =>
        run.pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              registry,
              { databaseLayer: Layer.succeed(SqlClient.SqlClient, sql) },
            ),
          ),
        ),
      ),
      Effect.provide(wrapper),
    );
    return (yield* Ref.get(attempts)).map(
      (text) =>
        text.includes(CHAT_REPLIES_DISPLAY_MODE.notice) ||
        text.includes(CHAT_REPLIES_DISPLAY_MODE.stateNotice),
    );
  }).pipe(Effect.scoped);

describe("display mode note at turn start", () => {
  it.live("goes once on the first message, and again after a failed native resume", () =>
    Effect.gen(function* () {
      const outputSchema = { type: "object" };
      const rewrapped = yield* Ref.make("");
      const notes = yield* notesPerAttempt(
        "display-wrap-resume",
        ({ send, failResume, lastAttempt }) =>
          Effect.gen(function* () {
            yield* send(1);
            yield* send(2);
            yield* Ref.set(failResume, true);
            yield* send(3, undefined, undefined, outputSchema);
            yield* Ref.set(rewrapped, yield* lastAttempt);
            yield* send(4);
          }),
      );
      assert.deepEqual(notes, [true, false, true, false]);
      // The re-wrapped prompt keeps one copy of the output instructions, after the user's words.
      const text = yield* Ref.get(rewrapped);
      const instructions = outputInstructions(outputSchema);
      assert.strictEqual(text.split(instructions).length, 2);
      assert.isTrue(text.endsWith(`Request 3\n\n${instructions}`));
    }),
  );

  it.live("goes again after a provider switch", () =>
    Effect.gen(function* () {
      const notes = yield* notesPerAttempt("display-wrap-switch", ({ send }) =>
        Effect.gen(function* () {
          yield* send(1);
          yield* send(2, CODEX_MODEL_SELECTION);
          yield* send(3, CODEX_MODEL_SELECTION);
        }),
      );
      assert.deepEqual(notes, [true, true, false]);
    }),
  );

  it.live("goes again when the provider refused the turn that carried it", () =>
    Effect.gen(function* () {
      const notes = yield* notesPerAttempt("display-wrap-refused", ({ send, failStart }) =>
        Effect.gen(function* () {
          yield* Ref.set(failStart, true);
          yield* send(1);
          yield* send(2);
          yield* send(3);
        }),
      );
      assert.deepEqual(notes, [true, true, false]);
    }),
  );

  it.live("goes again after a rollback, which can take the turn that carried it", () =>
    Effect.gen(function* () {
      const notes = yield* notesPerAttempt(
        "display-wrap-rollback",
        ({ send, rollBackToFirstCheckpoint }) =>
          Effect.gen(function* () {
            yield* send(1);
            yield* send(2);
            yield* rollBackToFirstCheckpoint;
            yield* send(3);
            yield* send(4);
          }),
      );
      assert.deepEqual(notes, [true, false, true, false]);
    }),
  );

  it.live(
    "goes in a native fork, whose agent holds its source's note, in the fork's own mode",
    () =>
      Effect.gen(function* () {
        const inFork = yield* Ref.make("");
        yield* notesPerAttempt("display-wrap-fork", ({ send, sendInFork }) =>
          Effect.gen(function* () {
            yield* send(1);
            yield* Ref.set(inFork, yield* sendInFork);
          }),
        );
        assert.strictEqual(
          yield* Ref.get(inFork),
          `${displayNote("unknown", NORMAL_DISPLAY)}\nRequest in the fork`,
        );
      }),
  );

  it.live("goes in the new mode when a turn brings history back into a told conversation", () =>
    Effect.gen(function* () {
      const back = yield* Ref.make("");
      yield* notesPerAttempt("display-wrap-merge", ({ send, switchMode, lastAttempt }) =>
        Effect.gen(function* () {
          yield* send(1);
          yield* send(2, CODEX_MODEL_SELECTION);
          yield* switchMode(null);
          yield* send(3);
          yield* Ref.set(back, yield* lastAttempt);
        }),
      );
      assert.strictEqual(
        yield* Ref.get(back),
        `${displayNote("unknown", NORMAL_DISPLAY)}\nRequest 3`,
      );
    }),
  );

  it.live("goes beside a slash command, and stays owed until the provider delivers it", () =>
    Effect.gen(function* () {
      const notes = yield* notesPerAttempt(
        "display-wrap-command",
        ({ send, lastAttempt, toldModeAfterStart }) =>
          Effect.gen(function* () {
            yield* send(1, CLAUDE_MODEL_SELECTION, "/goal ship it");
            assert.strictEqual(
              yield* lastAttempt,
              `${CHAT_REPLIES_DISPLAY_MODE.notice}|/goal ship it`,
            );
            assert.isUndefined(yield* toldModeAfterStart);
            yield* send(2);
          }),
      );
      assert.deepEqual(notes, [true, true]);
    }),
  );

  it.live("stays untold when the attempt stopped before the provider got the turn", () =>
    Effect.gen(function* () {
      const notes = yield* notesPerAttempt(
        "display-wrap-stopped",
        ({ send, duringInjection, stopLatestRun, toldModeAfterStart }) =>
          Effect.gen(function* () {
            yield* send(1);
            assert.strictEqual(yield* toldModeAfterStart, CHAT_REPLIES_DISPLAY_MODE.toldId);
            yield* Ref.set(duringInjection, stopLatestRun);
            yield* send(2, CODEX_MODEL_SELECTION);
            assert.strictEqual(yield* toldModeAfterStart, NORMAL_DISPLAY_MODE.toldId);
          }),
      );
      assert.deepEqual(notes, [true]);
    }),
  );
});

describe("history for a new native thread", () => {
  it.live.each([
    { cause: "a provider switch", resumeFails: false },
    { cause: "a failed native resume", resumeFails: true },
  ])("carries the messages the agent sent to the user after $cause", ({ resumeFails }) =>
    Effect.gen(function* () {
      const history = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* notesPerAttempt(
        `display-wrap-history-${resumeFails}`,
        ({ send, failResume, injected }) =>
          Effect.gen(function* () {
            yield* send(1);
            yield* Ref.set(failResume, resumeFails);
            yield* send(2, resumeFails ? CLAUDE_MODEL_SELECTION : CODEX_MODEL_SELECTION);
            yield* Ref.get(injected).pipe(Effect.flatMap((texts) => Ref.set(history, texts)));
          }),
      );
      assert.include(yield* Ref.get(history), "Sent in run 1");
    }),
  );
});
