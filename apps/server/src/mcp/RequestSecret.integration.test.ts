import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
  type RunId,
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
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

// A thread keeps one MCP request namespace across its runs.
it.effect(
  "request_secret in a later run opens a new card for a clientRequestId an earlier run closed",
  () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("request-secret-reuse");
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
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "request-secret-reuse" },
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
      const layerTest = OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
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
            NodeCrypto.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const threadId = ThreadId.make("thread:request-secret-reuse");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped({ startImmediately: true }),
          );
        const turnRunning = () =>
          watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
        const cardOpened = (runId: RunId) =>
          watch(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "secret_request" &&
              event.payload.runId === runId &&
              event.payload.secretStatus === "pending",
          );
        const startRun = (name: string) =>
          Effect.gen(function* () {
            const running = yield* turnRunning();
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`start-${name}`),
              threadId,
              messageId: MessageId.make(`message:${name}`),
              text: "Check the router",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* Fiber.join(running);
            return turns.at(-1)!;
          });

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:request-secret-reuse"),
          title: "Thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:request-secret-reuse"),
          requestNamespace: "provider-session:request-secret-reuse",
          thread: {
            threadId,
            providerSessionId: "provider-session:request-secret-reuse",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const ask = {
          label: "Router API key",
          reason: "Reads the firewall rules.",
          delivery: "file" as const,
          clientRequestId: "router-key",
        };

        // The first run asks, and the card closes unanswered.
        const first = yield* startRun("first");
        const firstCall = yield* service
          .requestSecret(scope, { ...ask, timeoutMs: 1_000 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual((yield* Fiber.join(firstCall)).status, "timed_out");
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).turnItems.flatMap((item) =>
            item.type === "secret_request" ? [item.secretStatus] : [],
          ),
          ["cancelled"],
        );

        const now = yield* DateTime.now;
        const providerTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const firstSettled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.turn.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(first.events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...providerTurn, status: "completed", completedAt: now },
        });
        yield* Queue.offer(first.events, {
          type: "turn.terminal",
          driver,
          providerThreadId: providerTurn.providerThreadId,
          providerTurnId: providerTurn.id,
          runOrdinal: first.turn.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(firstSettled);
        yield* worker.drain();

        // A later run, having lost its context, asks again with the same clientRequestId.
        const second = yield* startRun("second");
        const secondOpened = yield* cardOpened(second.turn.runId);
        const secondCall = yield* service
          .requestSecret(scope, ask)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const outcome = yield* Effect.raceFirst(
          Fiber.join(secondOpened).pipe(Effect.as("opened a card" as const)),
          Fiber.join(secondCall),
        );
        assert.deepEqual(outcome, "opened a card");
        yield* Fiber.interrupt(secondCall);
      }).pipe(Effect.provide(layerTest));
    }),
);
