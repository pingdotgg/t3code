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

it.effect("rechecks run ownership immediately before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const threadId = ThreadId.make("thread:run-execution-start-guard");
    const runId = RunId.make("run:run-execution-start-guard");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-start-guard");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-start-guard");
    const rootNodeId = NodeId.make("node:run-execution-start-guard");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
    } as OrchestrationV2Run;
    const rootNode = { id: rootNodeId } as OrchestrationV2ExecutionNode;
    const providerThread = {
      id: providerThreadId,
      driver,
    } as OrchestrationV2ProviderThread;
    const attempt = {
      id: attemptId,
      providerTurnId: null,
    } as OrchestrationV2RunAttempt;
    const session = {
      events: Stream.never,
      startTurn: () => Ref.update(providerStarts, (count) => count + 1),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-start-guard"),
      appThread: rootAppThread(threadId),
      providerSessionId,
      session,
      run,
      rootNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard"),
      } as OrchestrationV2CheckpointScope,
      providerThread,
      attempt,
      attemptId,
      providerTurnOrdinal: 1,
      shouldStartProviderTurn: () =>
        Ref.modify(guardCalls, (calls) => [calls === 0, calls + 1] as const),
      message: {
        messageId: MessageId.make("message:run-execution-start-guard"),
        text: "Do not start after ownership changes.",
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

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
  }).pipe(Effect.provide(layerRunExecutionTest)),
);

it.effect("passes the thread's MCP app context to the provider under a safe key", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const started = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2TurnInput>();
    const threadId = ThreadId.make("thread:run-execution-app-context");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const attemptId = RunAttemptId.make("attempt:run-execution-app-context");
    const session = {
      events: Stream.never,
      startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Deferred.succeed(started, input),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-app-context"),
      appThread: rootAppThread(threadId),
      providerSessionId: ProviderSessionId.make("session:run-execution-app-context"),
      session,
      run: {
        id: RunId.make("run:run-execution-app-context"),
        threadId,
        ordinal: 1,
        providerInstanceId,
      } as OrchestrationV2Run,
      rootNode: {
        id: NodeId.make("node:run-execution-app-context"),
      } as OrchestrationV2ExecutionNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-app-context"),
      } as OrchestrationV2CheckpointScope,
      providerThread: {
        id: ProviderThreadId.make("provider-thread:run-execution-app-context"),
        driver,
      } as OrchestrationV2ProviderThread,
      attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
      attemptId,
      providerTurnOrdinal: 1,
      message: {
        messageId: MessageId.make("message:run-execution-app-context"),
        text: "What is on my list?",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });

    const input = yield* Deferred.await(started);
    assert.deepEqual(input.appContext, [
      { key: "mcp_app_turn-item_provider_codex_native-item_call-1", text: "2 overdue" },
    ]);
  }).pipe(
    Effect.provide(
      RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            PreviewAgentActivity.layer,
            Layer.mock(McpAppModelContext.McpAppModelContext)({
              forThread: () =>
                Effect.succeed([
                  {
                    itemId: "turn-item:provider:codex:native-item:call-1",
                    server: "my tools>",
                    tool: "list",
                    text: "2 overdue",
                  },
                ]),
            }),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({}),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      ),
    ),
  ),
);

it.effect("fails the run when its ownership check cannot be read before calling the provider", () =>
  Effect.gen(function* () {
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const threadId = ThreadId.make("thread:run-execution-start-guard-read");
    const runId = RunId.make("run:run-execution-start-guard-read");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard-read");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (input) =>
              Ref.update(writes, (current) => [...current, ...input.events]).pipe(
                Effect.as({ committed: true, storedEvents: [] }),
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

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-start-guard-read"),
        appThread: rootAppThread(threadId),
        providerSessionId: ProviderSessionId.make("session:run-execution-start-guard-read"),
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
        rootNode: {
          id: NodeId.make("node:run-execution-start-guard-read"),
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard-read"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ProviderThreadId.make("provider-thread:run-execution-start-guard-read"),
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        shouldStartProviderTurn: () =>
          Ref.getAndUpdate(guardCalls, (calls) => calls + 1).pipe(
            Effect.flatMap((calls) =>
              calls === 0
                ? Effect.succeed(true)
                : Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "database unavailable",
                    }),
                  ),
            ),
          ),
        shouldFinalizeRun: () =>
          Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({
              threadId,
              cause: "database unavailable",
            }),
          ),
        message: {
          messageId: MessageId.make("message:run-execution-start-guard-read"),
          text: "Start while the store is down.",
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

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
    const runUpdate = (yield* Ref.get(writes)).find((event) => event.type === "run.updated");
    assert.equal(
      runUpdate?.type === "run.updated" ? runUpdate.payload.status : undefined,
      "failed",
    );
  }),
);

it.effect(
  "dispatches only attachment-free compact commands through the native compaction path",
  () =>
    Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const calls: Array<string> = [];
      const attachment = ChatFileAttachment.make({
        type: "file",
        id: ChatAttachmentId.make("compact-file-12345678-1234-1234-1234-123456789abc"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      });
      const cases = [
        { text: " /compact ", attachments: [], expected: "compact" },
        { text: "/compact", attachments: [attachment], expected: "prompt" },
        { text: "Continue the work", attachments: [], expected: "prompt" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const threadId = ThreadId.make(`thread:compact-routing:${index}`);
        const attemptId = RunAttemptId.make(`attempt:compact-routing:${index}`);
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:compact-routing:${index}`),
          appThread: rootAppThread(threadId),
          providerSessionId: ProviderSessionId.make(`session:compact-routing:${index}`),
          session: {
            events: Stream.never,
            startTurn: () =>
              Effect.sync(() => {
                calls.push("prompt");
              }),
            compactThread: () =>
              Effect.sync(() => {
                calls.push("compact");
              }),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: RunId.make(`run:compact-routing:${index}`),
            threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
          } as OrchestrationV2Run,
          rootNode: {
            id: NodeId.make(`node:compact-routing:${index}`),
          } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint:compact-routing:${index}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ProviderThreadId.make(`provider-thread:compact-routing:${index}`),
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:compact-routing:${index}`),
            text: testCase.text,
            attachments: testCase.attachments,
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
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
      }
      assert.deepEqual(
        calls,
        cases.map((testCase) => testCase.expected),
      );
    }).pipe(Effect.provide(layerRunExecutionTest)),
);

it.effect("starts the provider when checkpoint baseline capture fails", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-baseline-failure");
    const runId = RunId.make("run:run-execution-baseline-failure");
    const attemptId = RunAttemptId.make("attempt:run-execution-baseline-failure");
    const providerThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-baseline-failure",
    );
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-baseline-failure");
    const rootNodeId = NodeId.make("node:run-execution-baseline-failure");
    const checkpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:run-execution-baseline-failure"),
    } as OrchestrationV2CheckpointScope;
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<
      ReadonlyArray<{
        events: ReadonlyArray<OrchestrationV2DomainEvent>;
        effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      }>
    >([]);
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: () =>
              Effect.fail(
                new CheckpointService.CheckpointBaselineCaptureError({
                  scopeId: checkpointScope.id,
                  ordinalWithinScope: 0,
                  cause: new Error("VCS process timed out"),
                }),
              ),
          }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Ref.update(writes, (current) => [
                ...current,
                { events: input.events, effects: input.effects },
              ]).pipe(Effect.as([])),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-baseline-failure"),
        appThread: rootAppThread(threadId),
        providerSessionId,
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-baseline-failure"),
          text: "Start the provider without a baseline.",
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

    assert.equal(yield* Ref.get(providerStarts), 1);

    const events = (yield* Ref.get(writes)).flatMap((write) => [...write.events]);
    const failedEvent = events.find(
      (event) =>
        (event.type === "run.updated" ||
          event.type === "run-attempt.updated" ||
          event.type === "node.updated") &&
        event.payload.status === "failed",
    );
    assert.isUndefined(failedEvent);
    const errorItem = events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "error",
    );
    assert.isUndefined(errorItem);
  }),
);

it.effect.each(["failure", "interruption", "stale-attempt", "start-guard"] as const)(
  "handles %s before the provider turn starts",
  (scenario) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:run-execution-settings-failure");
      const runId = RunId.make("run:run-execution-settings-failure");
      const attemptId = RunAttemptId.make("attempt:run-execution-settings-failure");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("session:run-execution-settings-failure");
      const providerThreadId = ProviderThreadId.make(
        "provider-thread:run-execution-settings-failure",
      );
      const rootNodeId = NodeId.make("node:run-execution-settings-failure");
      const checkpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-settings-failure"),
      } as OrchestrationV2CheckpointScope;
      const providerStarts = yield* Ref.make(0);
      const refreshes = yield* Ref.make(0);
      const guardedWrites = yield* Ref.make(0);
      const writes = yield* Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>>([]);
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            PreviewAgentActivity.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () =>
                scenario === "start-guard" ? Effect.void : Effect.die("not reached"),
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  assert.equal(input.threadId, threadId);
                  assert.equal(input.runId, runId);
                  assert.equal(input.activeAttemptId, attemptId);
                  assert.equal(input.expectedStatus, "running");
                  yield* Ref.update(guardedWrites, (count) => count + 1);
                  if (scenario === "stale-attempt") {
                    return { committed: false, storedEvents: [] };
                  }
                  yield* Ref.update(writes, (current) => [...current, input.events]);
                  return { committed: true, storedEvents: [] };
                }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            scenario === "start-guard"
              ? ServerSettings.layerTest()
              : Layer.mock(ServerSettings.ServerSettingsService)({
                  getSettings:
                    scenario === "interruption"
                      ? Effect.interrupt
                      : Effect.fail(
                          new ServerSettingsError({
                            settingsPath: "<test>",
                            operation: "read-file",
                            cause: new Error("settings read failed"),
                          }),
                        ),
                }),
            Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
              refresh: () => Effect.void,
              refreshAfterTurn: () => Ref.update(refreshes, (count) => count + 1),
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:run-execution-settings-failure"),
          appThread: rootAppThread(threadId),
          providerSessionId,
          session: {
            events: Stream.never,
            startTurn: () => Ref.update(providerStarts, (count) => count + 1),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            status: "running",
          } as OrchestrationV2Run,
          rootNode: { id: rootNodeId, status: "running" } as OrchestrationV2ExecutionNode,
          checkpointScope,
          providerThread: {
            id: providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: attemptId,
            providerTurnId: null,
            status: "running",
          } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          ...(scenario === "start-guard"
            ? { shouldStartProviderTurn: () => Effect.succeed(false) }
            : {}),
          message: {
            messageId: MessageId.make("message:run-execution-settings-failure"),
            text: "Start after settings fail.",
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
      }).pipe(Effect.provide(layerTest), Effect.exit);

      assert.equal(yield* Ref.get(providerStarts), 0);
      const events = (yield* Ref.get(writes)).flat();
      if (scenario === "interruption") {
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.isTrue(Exit.isSuccess(result));
      if (scenario === "start-guard") {
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(guardedWrites), 1);
      if (scenario === "stale-attempt") {
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(refreshes), 1);
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "run.updated" ||
              event.type === "run-attempt.updated" ||
              event.type === "node.updated",
          )
          .map((event) => event.payload.status),
        ["failed", "failed", "failed"],
      );
      const errorItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "error",
      );
      assert.isDefined(errorItem);
      if (errorItem?.type === "turn-item.updated" && errorItem.payload.type === "error") {
        assert.equal(errorItem.payload.failure.message, "Run preparation failed.");
      }
    }),
);
