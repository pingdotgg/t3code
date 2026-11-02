import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

// A delegated child that fails on a usage limit is armed to continue at the reset.
// Once its parent cancels the task, nothing is waiting for that continuation.
it.effect.each([
  { cancel: "after its limit", cancelStatus: "failed", resumed: false },
  { cancel: "as its limit lands", cancelStatus: "cancel_requested", resumed: false },
  { cancel: "never", cancelStatus: null, resumed: true },
] as const)(
  "a delegated child whose task is cancelled $cancel resumes at the reset: $resumed",
  ({ cancel, cancelStatus, resumed }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("task-cancel-usage-limit");
        // Set while the provider's usage-limit result is already on its way.
        let limitInFlight: Effect.Effect<void> = Effect.void;
        const turns: Array<{
          readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
          readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
        }> = [];
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities: ClaudeProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    turns.push({ turn, events });
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: null,
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: () => Effect.die("unused"),
                interruptTurn: () => Effect.suspend(() => limitInFlight),
                respondToRuntimeRequest: () => Effect.die("unused"),
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "task-cancel-usage-limit" },
          layerAdapters,
          { runEffectWorker: false },
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const sweeps = new Map<string, Effect.Effect<void>>();
        const layerRecovery = UsageLimitRecoveryWorker.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Scheduler.Scheduler, {
                register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
                  Effect.gen(function* () {
                    const context = yield* Effect.context<R>();
                    sweeps.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
                  }),
              }),
              ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ServerSettings.layerTest({ autoResumeLimitedThreads: true }),
            ),
          ),
        );
        const layerTest = Layer.merge(
          OrchestratorMcpService.layer.pipe(
            Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
            Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          ),
          layerRecovery,
        ).pipe(
          Layer.provideMerge(layerOrchestration),
          Layer.provide(
            Layer.mergeAll(
              layerAdapters,
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(RemoteDelegation.RemoteDelegation)({}),
              ServerSettings.layerTest(),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              NodeServices.layer,
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const sweep = Effect.andThen(
            Effect.suspend(() => sweeps.get("usage-limit-recovery")!),
            worker.drain(),
          );
          const parentThreadId = ThreadId.make("thread:task-cancel-limit-parent");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          const turnRunning = () =>
            watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-parent"),
            threadId: parentThreadId,
            projectId: ProjectId.make("project:task-cancel-limit"),
            title: "Parent",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const parentRunning = yield* turnRunning();
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-parent"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:start-parent"),
            text: "Delegate a review",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(parentRunning);

          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
          const childRunning = yield* turnRunning();
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make("delegate"),
            parentThreadId,
            parentRunId: parentRun.id,
            parentNodeId: parentRun.rootNodeId!,
            task: "Review the change",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          yield* Fiber.join(childRunning);
          const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
          const childThreadId = task.childThreadId!;
          const child = turns.find((entry) => entry.turn.threadId === childThreadId)!;
          const childTurn = (yield* orchestrator.getThreadProjection(childThreadId))
            .providerTurns[0]!;

          const scope: McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:task-cancel-limit"),
            requestNamespace: "provider-session:task-cancel-limit",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "provider-session:task-cancel-limit",
              providerInstanceId: instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const cancelTask = Effect.gen(function* () {
            const result = yield* service.cancelTask(scope, {
              taskId: task.id,
              clientRequestId: "cancel-task",
            });
            yield* worker.drain();
            return result.status;
          });

          const now = yield* DateTime.now;
          const childFailed = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === child.turn.runId &&
              event.payload.status === "failed",
          );
          const hitLimit = Effect.forEach(
            [
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...childTurn, status: "failed", completedAt: now },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: childTurn.providerThreadId,
                providerTurnId: childTurn.id,
                runOrdinal: child.turn.runOrdinal,
                failureItemOrdinal: 1,
                status: "failed",
                failure: {
                  class: "usage_limit",
                  message: "Claude usage limit reached.",
                  code: null,
                  retryable: null,
                  resetAt: DateTime.formatIso(DateTime.add(now, { minutes: 1 })),
                },
                threadDisposition: "reusable",
              },
            ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
            (event) => Queue.offer(child.events, event),
            { discard: true },
          );
          let cancelled: string | null = null;
          if (cancel === "as its limit lands") {
            limitInFlight = hitLimit;
            cancelled = yield* cancelTask;
          } else {
            yield* hitLimit;
          }
          yield* Fiber.join(childFailed);
          yield* worker.drain();

          // The sweep runs every few seconds, so it arms the child before a parent reacts.
          yield* sweep;
          if (cancel === "after its limit") cancelled = yield* cancelTask;
          assert.equal(cancelled, cancelStatus);

          yield* TestClock.adjust("1 minute");
          yield* sweep;
          const childAfter = yield* orchestrator.getThreadProjection(childThreadId);
          assert.deepEqual(
            childAfter.messages.flatMap((message) =>
              message.role === "user" ? [message.text] : [],
            ),
            resumed ? ["Review the change", "Continue where you left off."] : ["Review the change"],
          );
        }).pipe(Effect.provide(layerTest));
      }),
    ),
);
