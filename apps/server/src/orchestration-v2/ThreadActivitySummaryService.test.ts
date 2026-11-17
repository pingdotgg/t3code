import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadActivitySummary from "./ThreadActivitySummaryService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:activity-summary");
const instances = {
  claude: { id: ProviderInstanceId.make("claude"), driver: ProviderDriverKind.make("claudeAgent") },
  codex: { id: ProviderInstanceId.make("codex"), driver: ProviderDriverKind.make("codex") },
  cursor: { id: ProviderInstanceId.make("cursor"), driver: ProviderDriverKind.make("cursor") },
} as const;
type InstanceName = keyof typeof instances;

const adapterFor = (name: InstanceName) =>
  ({
    instanceId: instances[name].id,
    driver: instances[name].driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("provider execution is disabled in activity summary tests"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const providerInstance = (name: InstanceName): ProviderInstance => ({
  instanceId: instances[name].id,
  driverKind: instances[name].driver,
  continuationIdentity: { driverKind: instances[name].driver, continuationKey: name },
  displayName: undefined,
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter: adapterFor(name),
  textGeneration: {} as ProviderInstance["textGeneration"],
});

interface ActivityCall {
  readonly input: TextGeneration.ThreadActivityGenerationInput;
  readonly answer: Deferred.Deferred<
    TextGeneration.ThreadActivityGenerationResult,
    TextGenerationError
  >;
}

const makeHarness = Effect.fn(function* (settings: { readonly enabled: boolean }) {
  const calls = yield* Ref.make<ReadonlyArray<TextGeneration.ThreadActivityGenerationInput>>([]);
  const pending = yield* Queue.unbounded<ActivityCall>();
  const warnings = yield* Queue.unbounded<unknown>();
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-activity-summary" },
    ProviderAdapterRegistry.layerFromAdapters([
      adapterFor("claude"),
      adapterFor("codex"),
      adapterFor("cursor"),
    ]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({
    threadActivitySummaryEnabled: settings.enabled,
  });
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requested) =>
      Effect.succeed(
        requested === projectId
          ? Option.some({
              projectId,
              title: "Project",
              hasCustomTitle: false,
              workspaceRoot: "/repo",
              defaultModelSelection: { instanceId: instances.claude.id, model: "claude-opus-5-5" },
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              pinnedAt: null,
              archivedAt: null,
              createdAt: "2026-11-04T00:00:00.000Z",
              updatedAt: "2026-11-04T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const layerTextGeneration = Layer.mock(TextGeneration.TextGeneration)({
    generateThreadActivity: (input) =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<
          TextGeneration.ThreadActivityGenerationResult,
          TextGenerationError
        >();
        yield* Ref.update(calls, (current) => [...current, input]);
        yield* Queue.offer(pending, { input, answer });
        return yield* Deferred.await(answer);
      }),
  });
  const layerInstances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (id) =>
      Effect.succeed(
        (Object.keys(instances) as Array<InstanceName>)
          .filter((name) => instances[name].id === id)
          .map(providerInstance)[0],
      ),
  });
  const layerSummary = ThreadActivitySummary.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerOrchestrator,
        layerProjects,
        layerServerSettings,
        layerTextGeneration,
        layerInstances,
      ),
    ),
  );
  const layerWarnings = Logger.layer(
    [
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") Queue.offerUnsafe(warnings, message);
      }),
    ],
    { mergeWithExisting: false },
  );
  return {
    layer: Layer.mergeAll(layerOrchestrator, layerServerSettings, layerSummary, layerWarnings),
    calls,
    pending,
    warnings,
  };
});

const commandEvent = (threadId: ThreadId, runId: RunId, id: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make(`event:${id}`),
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(id),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution",
        input: `vp test run ${id}`,
      },
    };
    return event;
  });

const runEvent = (run: OrchestrationV2Run, suffix: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`${run.id}:${suffix}`),
  type: "run.updated",
  threadId: run.threadId,
  runId: run.id,
  occurredAt: run.requestedAt,
  payload: run,
});

/** Creates a thread with a running run, then feeds the service enough tools to summarize now. */
const startRun = (name: string, instance: InstanceName) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const service = yield* ThreadActivitySummary.ThreadActivitySummaryService;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${name}`);
    const runId = RunId.make(`run:${name}`);
    const modelSelection = { instanceId: instances[instance].id, model: "agent-model" };
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:${name}:create`),
      threadId,
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: ProviderThreadId.make(`${threadId}:provider`),
      userMessageId: MessageId.make(`${runId}:user`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: run,
        },
        {
          id: EventId.make(`${runId}:user`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: run.userMessageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: `Add a status chip to the sidebar for ${name}`,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    yield* service.handle(runEvent(run, "running"));
    for (const index of [1, 2, 3]) {
      yield* service.handle(yield* commandEvent(threadId, runId, `${name}:tool:${index}`));
    }
    return run;
  });

const awaitActivity = (threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.stream({ threadId, eventType: "thread.metadata-updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "thread.metadata-updated" &&
          stored.event.payload.activity?.label === label,
      ),
      Stream.runHead,
    );
  });

const summary = (
  label: string,
  phase: TextGeneration.ThreadActivityGenerationResult["phase"] = "implementing",
): TextGeneration.ThreadActivityGenerationResult => ({ phase, label });

const answer = (call: ActivityCall, threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    yield* Deferred.succeed(call.answer, summary(label));
    yield* awaitActivity(threadId, label);
  });

describe("ThreadActivitySummaryService", () => {
  it.effect("summarizes a Claude thread with Haiku", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: true });
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const run = yield* startRun("claude-haiku", "claude");
        const call = yield* Queue.take(harness.pending);
        assert.deepStrictEqual(call.input.modelSelection, {
          instanceId: instances.claude.id,
          model: "claude-haiku-5-5",
        });
        assert.strictEqual(call.input.cwd, "/repo");
        assert.isNull(call.input.previous);
        assert.include(call.input.digest, "Add a status chip to the sidebar");
        assert.include(call.input.digest, "vp test run claude-haiku:tool:3");
        yield* answer(call, run.threadId, "sidebar status chip");
        const shell = yield* engine.getThreadShell(run.threadId);
        assert.strictEqual(shell?.activity?.phase, "implementing");
        assert.strictEqual(shell?.activity?.label, "sidebar status chip");
        assert.lengthOf(yield* Ref.get(harness.calls), 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
  it.effect("summarizes a Codex thread with Luna at low effort", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: true });
      yield* Effect.gen(function* () {
        yield* startRun("codex-luna", "codex");
        const call = yield* Queue.take(harness.pending);
        assert.deepStrictEqual(call.input.modelSelection, {
          instanceId: instances.codex.id,
          model: "gpt-6-luna",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("skips unsupported drivers and a disabled setting", () =>
    Effect.gen(function* () {
      for (const [enabled, instance] of [
        [true, "cursor"],
        [false, "claude"],
      ] as const) {
        const harness = yield* makeHarness({ enabled });
        yield* Effect.gen(function* () {
          yield* startRun(`skipped-${instance}`, instance);
          yield* TestClock.adjust("2 minutes");
          assert.lengthOf(yield* Ref.get(harness.calls), 0);
        }).pipe(Effect.provide(harness.layer));
      }
    }),
  );

  it.effect("waits for the refresh interval", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: true });
      yield* Effect.gen(function* () {
        const service = yield* ThreadActivitySummary.ThreadActivitySummaryService;
        const run = yield* startRun("refresh", "claude");
        yield* answer(yield* Queue.take(harness.pending), run.threadId, "first label");
        yield* service.handle(yield* commandEvent(run.threadId, run.id, "refresh:tool:4"));
        yield* TestClock.adjust("29 seconds");
        assert.lengthOf(yield* Ref.get(harness.calls), 1);
        yield* TestClock.adjust("1 second");
        const second = yield* Queue.take(harness.pending);
        assert.deepStrictEqual(second.input.previous, {
          phase: "implementing",
          label: "first label",
        });
        yield* answer(second, run.threadId, "second label");
        yield* TestClock.adjust("2 minutes");
        assert.lengthOf(yield* Ref.get(harness.calls), 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("drops a summary that resolves after the run ended", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: true });
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const service = yield* ThreadActivitySummary.ThreadActivitySummaryService;
        const run = yield* startRun("ended", "claude");
        const call = yield* Queue.take(harness.pending);
        const now = yield* DateTime.now;
        const ended = runEvent({ ...run, status: "completed", completedAt: now }, "completed");
        yield* eventSink.write({ events: [ended] });
        yield* service.handle(ended);
        yield* Deferred.succeed(call.answer, summary("too late", "testing"));
        assert.isNull((yield* engine.getThreadShell(run.threadId))?.activity ?? null);
        assert.isNotOk((yield* engine.getThreadProjection(run.threadId)).thread.activity);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("uses the thread's current driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: true });
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const service = yield* ThreadActivitySummary.ThreadActivitySummaryService;
        const run = yield* startRun("switch", "claude");
        const first = yield* Queue.take(harness.pending);
        assert.strictEqual(first.input.modelSelection.model, "claude-haiku-5-5");
        yield* answer(first, run.threadId, "before switch");
        const { thread } = yield* engine.getThreadProjection(run.threadId);
        const now = yield* DateTime.now;
        const codexSelection = { instanceId: instances.codex.id, model: "agent-model" };
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${run.id}:switched`),
              type: "thread.model-selection-updated",
              threadId: run.threadId,
              occurredAt: now,
              payload: {
                ...thread,
                providerInstanceId: codexSelection.instanceId,
                modelSelection: codexSelection,
              },
            },
          ],
        });
        yield* service.handle(yield* commandEvent(run.threadId, run.id, "switch:tool:4"));
        yield* TestClock.adjust("30 seconds");
        const second = yield* Queue.take(harness.pending);
        assert.strictEqual(second.input.modelSelection.instanceId, instances.codex.id);
        assert.strictEqual(second.input.modelSelection.model, "gpt-6-luna");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("backs off after a failure", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: true });
      yield* Effect.gen(function* () {
        yield* startRun("failure", "claude");
        const first = yield* Queue.take(harness.pending);
        yield* Deferred.fail(
          first.answer,
          new TextGenerationError({ operation: "generateThreadActivity", detail: "offline" }),
        );
        yield* Queue.take(harness.warnings);
        yield* TestClock.adjust("59 seconds");
        assert.lengthOf(yield* Ref.get(harness.calls), 1);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(harness.pending);
        assert.lengthOf(yield* Ref.get(harness.calls), 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("caps concurrent summaries at 3", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: true });
      yield* Effect.gen(function* () {
        for (const index of [1, 2, 3, 4]) {
          yield* startRun(`concurrent-${index}`, "claude");
        }
        const started = [
          yield* Queue.take(harness.pending),
          yield* Queue.take(harness.pending),
          yield* Queue.take(harness.pending),
        ];
        assert.lengthOf(yield* Ref.get(harness.calls), 3);
        yield* Deferred.succeed(started[0]!.answer, summary("first done", "testing"));
        yield* Queue.take(harness.pending);
        assert.lengthOf(yield* Ref.get(harness.calls), 4);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("stops summarizing when the setting is turned off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: true });
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const service = yield* ThreadActivitySummary.ThreadActivitySummaryService;
        const run = yield* startRun("turned-off", "claude");
        yield* answer(yield* Queue.take(harness.pending), run.threadId, "while enabled");
        yield* settings.updateSettings({ threadActivitySummaryEnabled: false });
        for (const index of [4, 5, 6]) {
          yield* service.handle(yield* commandEvent(run.threadId, run.id, `off:tool:${index}`));
        }
        yield* TestClock.adjust("30 seconds");
        yield* TestClock.adjust("2 minutes");
        assert.lengthOf(yield* Ref.get(harness.calls), 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
