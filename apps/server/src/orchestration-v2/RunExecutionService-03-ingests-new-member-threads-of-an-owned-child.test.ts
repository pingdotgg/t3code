import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ChatAttachmentId,
  ChatFileAttachment,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

import {
  backgroundScenarioIds,
  backgroundTurnItemEvent,
  backgroundTurnItemEventForRun,
  captureRootRunTermination,
  childBackgroundTurnItemEvent,
  childThreadCreatedEvent,
  driver,
  layerRunExecutionTest,
  layerTurnItemPositionsTest,
  makeLinkedChildTurnItemFixture,
  makeRunOwnedSubagentChildNodeFixture,
  makeRunOwnedSubagentFixture,
  makeRunOwnedSubagentNodeFixture,
  makeRunOwnedSubagentTurnItemFixture,
  rootAppThread,
  rootTerminalEvent,
  runBackgroundItemScenario,
  subagentEvent,
} from "./RunExecutionService-fixtures.testkit.ts";
import type { BackgroundScenarioIds } from "./RunExecutionService-fixtures.testkit.ts";

it.effect("ingests new member threads of an owned child after the root turn terminalizes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-late-child");
    const childThreadId = ThreadId.make("thread:run-execution-late-child:child");
    const memberThreadId = ThreadId.make("thread:run-execution-late-child:member");
    const runId = RunId.make("run:run-execution-late-child");
    const attemptId = RunAttemptId.make("attempt:run-execution-late-child");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-late-child");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-late-child");
    const childProviderThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-late-child:child",
    );
    const rootProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child");
    const childProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child:child");
    const rootNodeId = NodeId.make("node:run-execution-late-child");
    const childNodeId = NodeId.make("node:run-execution-late-child:child");
    const subagentNodeId = NodeId.make("node:run-execution-late-child:subagent");
    const childMessageIngested = yield* Deferred.make<void>();
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const origins = yield* Ref.make<ReadonlyArray<readonly [string, unknown, unknown]>>([]);
    const requests = yield* Ref.make<ReadonlyArray<string>>([]);
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderUsageAnalytics.ProviderTurnAnalytics, {
            runStarted: (input) =>
              Ref.update(requests, (current) => [...current, `started:${input.runId}`]),
            turnCompleted: () => Effect.void,
            runSettled: (input) =>
              Ref.update(requests, (current) => [
                ...current,
                `settled:${input.runId}:${input.status}:children-running=${input.childrenRunning}`,
              ]),
          }),
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === runId,
                  )
                ) {
                  yield* Ref.update(order, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                const eventType = input.event.type;
                yield* Ref.update(origins, (current) => [
                  ...current,
                  [
                    eventType,
                    input.analyticsContext?.origin,
                    input.analyticsContext?.segment,
                  ] as const,
                ]);
                if (
                  input.event.type === "app_thread.created" &&
                  input.event.appThread.id === memberThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "member-thread"]);
                }
                if (
                  input.event.type === "message.updated" &&
                  input.event.message.threadId === memberThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "child-message"]);
                  yield* Deferred.succeed(childMessageIngested, undefined).pipe(Effect.ignore);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
      {
        type: "app_thread.created",
        driver,
        appThread: {
          id: childThreadId,
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "provider_thread.updated",
        driver,
        providerThread: {
          id: childProviderThreadId,
          appThreadId: childThreadId,
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          ...makeRunOwnedSubagentFixture({
            ids: backgroundScenarioIds("run-execution-late-child"),
            providerInstanceId,
            childThreadId,
            driver,
            status: "running",
          }),
          workflow: {
            phases: [],
            agents: [
              { index: 0, label: "Reviewer", state: "running", childThreadId: memberThreadId },
            ],
          },
        },
      },
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "running",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: rootProviderTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      },
      {
        type: "app_thread.created",
        driver,
        appThread: {
          id: memberThreadId,
          lineage: {
            parentThreadId: childThreadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make("message:run-execution-late-child:child"),
          threadId: memberThreadId,
          runId: null,
          nodeId: childNodeId,
          role: "assistant",
          text: "Hello.",
          streaming: false,
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "completed",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "completed",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-late-child"),
        appThread: rootAppThread(threadId),
        providerSessionId,
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-late-child"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: rootProviderTurnId,
          reason: "initial",
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-late-child:user"),
          text: "Spawn a child and finish.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(layerTest));

    const observed = yield* Deferred.await(childMessageIngested).pipe(
      Effect.timeoutOption("2 seconds"),
    );
    assert.isTrue(Option.isSome(observed), "child message was not ingested after root terminal");
    assert.deepEqual(yield* Ref.get(order), ["root-finalized", "member-thread", "child-message"]);
    // The run's message started the root; the parent agent started the child's turn.
    const recorded = yield* Ref.get(origins);
    assert.deepEqual(recorded[0]?.slice(0, 2), [
      "app_thread.created",
      { createdBy: "user", creationSource: "web", scheduled: false, subagent: false },
    ]);
    assert.deepEqual(
      recorded.find(([type]) => type === "provider_turn.updated"),
      [
        "provider_turn.updated",
        { createdBy: "agent", creationSource: "provider", scheduled: false, subagent: true },
        "native_child",
      ],
    );
    // The child outlives the root, so the request summary says its later turns are missing.
    assert.deepEqual(yield* Ref.get(requests), [
      `started:${runId}`,
      `settled:${runId}:completed:children-running=true`,
    ]);
  }),
);

it.effect("ends a nested native subagent and its thread when the root run is interrupted", () =>
  Effect.gen(function* () {
    const key = "run-execution-nested-native";
    const threadId = ThreadId.make(`thread:${key}`);
    const childThreadId = ThreadId.make(`thread:${key}:child`);
    const grandchildThreadId = ThreadId.make(`thread:${key}:grandchild`);
    const runId = RunId.make(`run:${key}`);
    const attemptId = RunAttemptId.make(`attempt:${key}`);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerThreadId = ProviderThreadId.make(`provider-thread:${key}`);
    const rootProviderTurnId = ProviderTurnId.make(`provider-turn:${key}`);
    const nestedId = NodeId.make(`node:${key}:nested`);
    const grandchildRootId = NodeId.make(`node:${key}:grandchild-root`);
    const finalized = yield* Deferred.make<ReadonlyArray<OrchestrationV2DomainEvent>>();
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.as(
                input.events.some((event) => event.type === "run.updated")
                  ? Deferred.succeed(finalized, input.events)
                  : Effect.void,
                [],
              ),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const subagentThread = (id: ThreadId, parentThreadId: ThreadId) =>
      ({
        type: "app_thread.created",
        driver,
        appThread: {
          id,
          lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId: threadId },
        },
      }) as ProviderAdapter.ProviderAdapterV2Event;
    const events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
      subagentThread(childThreadId, threadId),
      subagentThread(grandchildThreadId, childThreadId),
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: nestedId,
          threadId: childThreadId,
          runId: null,
          origin: "provider_native",
          childThreadId: grandchildThreadId,
          status: "running",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "node.updated",
        driver,
        node: {
          id: grandchildRootId,
          threadId: grandchildThreadId,
          runId: null,
          kind: "root_turn",
          status: "running",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: rootProviderTurnId,
        runOrdinal: 1,
        status: "interrupted",
        failure: null,
        threadDisposition: "reusable",
      },
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: rootAppThread(threadId),
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
        rootNode: { id: NodeId.make(`node:${key}`) } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: { id: providerThreadId, driver } as OrchestrationV2ProviderThread,
        attempt: { id: attemptId, providerTurnId: rootProviderTurnId } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Spawn a nested subagent.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        },
      });
    }).pipe(Effect.provide(layerTest));

    const ended = (yield* Deferred.await(finalized)).flatMap((event) =>
      event.type === "subagent.updated" || event.type === "node.updated"
        ? [[event.type, event.payload.id, event.payload.status]]
        : [],
    );
    assert.deepInclude(ended, ["subagent.updated", nestedId, "interrupted"]);
    assert.deepInclude(ended, ["node.updated", grandchildRootId, "interrupted"]);
  }),
);

it.effect("keeps ingesting until queued background work clears after the probe goes idle", () =>
  Effect.gen(function* () {
    // The adapter's probe runs ahead of its event queue, so only the queued update may release.
    // A child transferred to another run takes its pending work with it.
    const pending = yield* Ref.make(true);
    const consumed = yield* Deferred.make<void>();
    const result = yield* Effect.raceFirst(
      runBackgroundItemScenario(
        "queued-background-work",
        (ids) => {
          const childProviderThreadId = ProviderThreadId.make(`${ids.providerThreadId}:child`);
          const childProviderTurnId = ProviderTurnId.make(`${ids.rootProviderTurnId}:child`);
          const running = subagentEvent(ids, "running");
          if (running.type !== "subagent.updated") throw new Error("Missing subagent");
          const linked = {
            ...running,
            subagent: {
              ...running.subagent,
              origin: "provider_native" as const,
              childThreadId: ids.childThreadId,
              providerThreadId: childProviderThreadId,
            },
          };
          const backgroundWork = (providerTurnId: ProviderTurnId, pending: boolean) =>
            ({
              type: "background_work.updated",
              driver,
              providerTurnId,
              pending,
            }) satisfies ProviderAdapter.ProviderAdapterV2Event;
          return [
            childThreadCreatedEvent(ids),
            linked,
            {
              type: "provider_turn.updated",
              driver,
              threadId: ids.childThreadId,
              providerTurn: {
                id: childProviderTurnId,
                providerThreadId: childProviderThreadId,
                runAttemptId: null,
                status: "completed",
              },
            } as ProviderAdapter.ProviderAdapterV2Event,
            backgroundWork(childProviderTurnId, true),
            backgroundWork(ids.rootProviderTurnId, true),
            rootTerminalEvent(ids, "completed"),
            { ...linked, subagent: { ...linked.subagent, runId: RunId.make("run:replacement") } },
            backgroundTurnItemEvent(ids, "dynamic_tool", "completed", 1),
            backgroundWork(ids.rootProviderTurnId, false),
          ];
        },
        {
          keepEventStreamOpen: true,
          hasPendingBackgroundWorkForThread: () => Ref.get(pending),
          onFinalized: () => Ref.set(pending, false),
          onEventsConsumed: Deferred.succeed(consumed, undefined).pipe(Effect.asVoid),
        },
      ).pipe(Effect.asSome),
      Deferred.await(consumed).pipe(Effect.as(Option.none())),
    );
    assert.deepEqual(
      result,
      Option.some(["subagent:running", "root-finalized", "turn_item:completed"]),
    );
  }),
);

it.effect("keeps ingesting a child thread's late background item completion", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-child-item", (ids) => [
      childThreadCreatedEvent(ids),
      subagentEvent(ids, "running"),
      childBackgroundTurnItemEvent(ids, "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      childBackgroundTurnItemEvent(ids, "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect.each([null, "run:nested-sdk"] as const)(
  "releases a settled run when its live child transfers to another run (%s)",
  (nestedRunId) =>
    Effect.gen(function* () {
      const consumed = yield* Deferred.make<void>();
      const result = yield* Effect.raceFirst(
        runBackgroundItemScenario(
          "child-transfer-release",
          (ids) => {
            const running = subagentEvent(ids, "running");
            if (running.type !== "subagent.updated") throw new Error("Missing subagent");
            const linked = {
              ...running,
              subagent: {
                ...running.subagent,
                origin: "provider_native" as const,
                childThreadId: ids.childThreadId,
                providerThreadId: null,
              },
            };
            return [
              childThreadCreatedEvent(ids),
              linked,
              {
                ...linked,
                subagent: {
                  ...linked.subagent,
                  id: NodeId.make("node:child-transfer-release:nested"),
                  threadId: ids.childThreadId,
                  runId: nestedRunId === null ? null : RunId.make(nestedRunId),
                  childThreadId: null,
                },
              },
              childBackgroundTurnItemEvent(ids, "running", 1),
              rootTerminalEvent(ids, "completed"),
              { ...linked, subagent: { ...linked.subagent, runId: RunId.make("run:replacement") } },
            ];
          },
          {
            keepEventStreamOpen: true,
            onEventsConsumed: Deferred.succeed(consumed, undefined).pipe(Effect.asVoid),
          },
        ).pipe(Effect.asSome),
        Deferred.await(consumed).pipe(Effect.as(Option.none())),
      );
      assert.isTrue(
        Option.isSome(result),
        "the transferred child must release its prior subscription",
      );
      if (Option.isSome(result))
        assert.deepEqual(result.value, [
          "subagent:running",
          "subagent:running",
          "turn_item:running",
          "root-finalized",
        ]);
    }),
);

it.effect(
  "ends preview activity when a transferred child settles a run kept open by background work",
  () =>
    Effect.gen(function* () {
      const active = yield* Deferred.make<boolean>();
      yield* runBackgroundItemScenario(
        "child-transfer-preview",
        (ids) => {
          const running = subagentEvent(ids, "running");
          if (running.type !== "subagent.updated") throw new Error("Missing subagent");
          const linked = {
            ...running,
            subagent: {
              ...running.subagent,
              origin: "provider_native" as const,
              childThreadId: ids.childThreadId,
              providerThreadId: null,
            },
          };
          return [
            childThreadCreatedEvent(ids),
            linked,
            backgroundTurnItemEvent(ids, "command_execution", "running", 1),
            rootTerminalEvent(ids, "completed"),
            { ...linked, subagent: { ...linked.subagent, runId: RunId.make("run:replacement") } },
          ];
        },
        {
          keepEventStreamOpen: true,
          afterEvents: (activity) =>
            activity
              .active(backgroundScenarioIds("child-transfer-preview").threadId)
              .pipe(Effect.flatMap((value) => Deferred.succeed(active, value))),
        },
      ).pipe(Effect.forkScoped);
      assert.isFalse(yield* Deferred.await(active));
    }).pipe(Effect.scoped),
);

it.effect("keeps ingesting a failed root's background item when its work continues", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-failed-continues", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      { ...rootTerminalEvent(ids, "failed"), childTurnsContinue: true },
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("does not pin ingestion on background items when the root turn is interrupted", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-interrupted", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "interrupted"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized"]);
  }),
);

it.effect("seeds inherited background items before their next update", () =>
  Effect.gen(function* () {
    const key = "inherited-background-seeded";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 1),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["root-finalized", "turn_item:completed"]);
  }),
);

it.effect("refreshes inherited background items after event subscription", () =>
  Effect.gen(function* () {
    const key = "inherited-background-subscription-refresh";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const itemStatus = yield* Ref.make<OrchestrationV2TurnItem["status"]>("running");
    const loadInheritedBackgroundTurnItems = () =>
      Ref.get(itemStatus).pipe(
        Effect.map((status) =>
          RunExecutionService.selectInheritedBackgroundTurnItems({
            threadId: ids.threadId,
            currentProviderThreadId: ids.providerThreadId,
            currentRunOrdinal: 2,
            runs: [
              {
                id: priorRunId,
                threadId: ids.threadId,
                ordinal: 1,
                status: "interrupted",
              } as OrchestrationV2Run,
            ],
            turnItems: [
              {
                id: ids.itemId,
                threadId: ids.threadId,
                runId: priorRunId,
                providerThreadId: ids.providerThreadId,
                type: "subagent",
                status,
              } as OrchestrationV2TurnItem,
            ],
          }),
        ),
      );

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems,
        onSubscribe: Ref.set(itemStatus, "completed"),
      },
    );

    assert.deepEqual(yield* loadInheritedBackgroundTurnItems(), []);
    assert.deepEqual(observed, ["root-finalized"]);
  }),
);
