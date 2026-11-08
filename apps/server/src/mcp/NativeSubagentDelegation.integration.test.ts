import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as DelegatedTaskQuestionReactor from "../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };
const claudeProvider: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [
    { slug: modelSelection.model, name: modelSelection.model, isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

// A runtime mode change detaches a Claude session, failing its running turn in the
// background; the stub keeps its session, so mode changes leave every turn running.
const capabilities = {
  ...ClaudeProviderCapabilitiesV2,
  sessions: { ...ClaudeProviderCapabilitiesV2.sessions, supportsRuntimeModeSwitchInSession: true },
};

interface StartedTurn {
  readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
}

const makeAdapter = (
  cwd: string,
  turns: Array<StartedTurn>,
  stops: Array<{ readonly appThreadId: ThreadId | null; readonly nativeTaskId: string }>,
  interrupts: Array<ThreadId | null>,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(capabilities),
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
          capabilities,
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
        // Like a provider, it confirms an interrupt by ending the turn.
        interruptTurn: ({ providerThread, providerTurnId }) =>
          Effect.gen(function* () {
            interrupts.push(providerThread.appThreadId);
            const started = turns.findLast(
              (entry) => `provider-turn:${entry.turn.attemptId}` === providerTurnId,
            );
            if (started === undefined) return;
            const now = yield* DateTime.now;
            yield* Queue.offerAll(started.events, [
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: providerThread.id,
                  nodeId: started.turn.rootNodeId,
                  runAttemptId: started.turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: started.turn.providerTurnOrdinal,
                  status: "interrupted",
                  startedAt: now,
                  completedAt: now,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: providerThread.id,
                providerTurnId,
                runOrdinal: started.turn.runOrdinal,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              },
            ]);
          }),
        stopSubagent: ({ providerThread, nativeTaskId }) =>
          Effect.gen(function* () {
            stops.push({ appThreadId: providerThread.appThreadId, nativeTaskId });
            return { status: "cancelled", completedAt: yield* DateTime.now, result: null } as const;
          }),
        respondToRuntimeRequest: () => Effect.die("unused"),
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
    }),
});

type StreamCall = Parameters<
  ThreadManagementService.ThreadManagementService["Service"]["streamStoredEventsFrom"]
>[0];

/** The orchestrator, the MCP service and the stub provider, for the test's scope. */
const makeHarness = (name: string) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const turns: Array<StartedTurn> = [];
    const stops: Array<{ readonly appThreadId: ThreadId | null; readonly nativeTaskId: string }> =
      [];
    const interrupts: Array<ThreadId | null> = [];
    // The MCP service subscribes to stored events when it starts waiting; tests wait on that.
    const streamCalls = yield* Queue.unbounded<StreamCall>();
    const callerResolutions = yield* Queue.unbounded<string>();
    const layerAdapters = ProviderAdapterRegistry.layerSingle(
      makeAdapter(cwd, turns, stops, interrupts),
    );
    const layerOrchestrator = ProviderReplayHarness.layerWithRegistry({ name }, layerAdapters, {
      runEffectWorker: false,
      runContinuationWorker: true,
      realThreadManagement: true,
    });
    const layerThreads = Layer.effect(
      ThreadManagementService.ThreadManagementService,
      Effect.map(ThreadManagementService.ThreadManagementService, (threads) => ({
        ...threads,
        streamStoredEventsFrom: (input?: StreamCall) =>
          Stream.unwrap(
            Queue.offer(streamCalls, input).pipe(Effect.as(threads.streamStoredEventsFrom(input))),
          ),
      })),
    ).pipe(
      Layer.provide(
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      ),
    );
    const layerMcpSessions = Layer.effect(
      McpProviderSessions.McpProviderSessions,
      Effect.map(McpProviderSessions.McpProviderSessions, (sessions) => ({
        ...sessions,
        resolveNativeCaller: (input) =>
          Effect.gen(function* () {
            // The registry does no I/O before suspending on its caller wait.
            const caller = yield* Effect.forkChild(sessions.resolveNativeCaller(input), {
              startImmediately: true,
            });
            yield* Queue.offer(callerResolutions, input.callId);
            return yield* Fiber.join(caller);
          }),
      })),
    ).pipe(Layer.provide(McpProviderSessions.layer));
    const layerTest = OrchestratorMcpService.layer.pipe(
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provideMerge(Layer.merge(layerOrchestrator, layerThreads)),
      Layer.provideMerge(layerMcpSessions),
      Layer.provide(
        Layer.mergeAll(
          layerAdapters,
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([claudeProvider]),
          }),
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

    const layerQuestions = DelegatedTaskQuestionReactor.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    const context = yield* Layer.build(Layer.merge(layerTest, layerQuestions));
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const questions = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      const now = yield* DateTime.now;
      // The cursor is read before forking, so an event written before the fiber runs still counts.
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        Effect.gen(function* () {
          const afterSequence = yield* eventSink.latestSequence();
          return yield* eventSink.stream({ afterSequence }).pipe(
            Stream.filter(({ event }) => predicate(event)),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        });
      const taskSettles = (taskId: NodeId) =>
        watch(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === taskId &&
            event.payload.result !== null,
        );
      const startRoot = (
        threadId: ThreadId,
        providerSessionId: string,
        modes: {
          readonly runtimeMode: OrchestrationV2AppThread["runtimeMode"];
          readonly interactionMode: OrchestrationV2AppThread["interactionMode"];
        } = { runtimeMode: "full-access", interactionMode: "default" },
      ) =>
        Effect.gen(function* () {
          const rootRunning = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.threadId === threadId &&
              event.payload.status === "running",
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${threadId}`),
            threadId,
            projectId: ProjectId.make("project:native-delegation"),
            title: "Root",
            modelSelection,
            ...modes,
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`start:${threadId}`),
            threadId,
            messageId: MessageId.make(`message:start:${threadId}`),
            text: "Fan out",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(rootRunning);
          yield* mcpSessions.set(sessionFor(threadId, providerSessionId));
          const projection = yield* orchestrator.getThreadProjection(threadId);
          return {
            projection,
            run: projection.runs[0]!,
            turn: turns.find((entry) => entry.turn.threadId === threadId)!,
          };
        });
      // Claude's adapter projects a native subagent like this, nested ones in their owner's thread.
      const nativeTask = (input: {
        readonly name: string;
        readonly listing: OrchestrationV2AppThread;
        readonly parentNodeId: NodeId;
        readonly execution: { readonly threadId: ThreadId; readonly runId: RunId };
      }) => {
        const id = NodeId.make(`node:native-${input.name}`);
        const childThreadId = ThreadId.make(`thread:native-${input.name}`);
        const task: OrchestrationV2Subagent = {
          id,
          threadId: input.listing.id,
          runId: input.execution.runId,
          ...(input.listing.id === input.execution.threadId
            ? {}
            : { executionThreadId: input.execution.threadId }),
          parentNodeId: input.parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: { driver, nativeId: `task-${input.name}`, strength: "strong" },
          prompt: `Work as ${input.name}`,
          title: input.name,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const thread = makeSubagentChildThread({
          parentThread: input.listing,
          childThreadId,
          parentNodeId: id,
          activeProviderThreadId: null,
          providerInstanceId: instanceId,
          modelSelection,
          title: input.name,
          now,
          createdBy: "agent",
          creationSource: "provider",
        });
        const rootNodeId = NodeId.make(`node:native-${input.name}:thread-root`);
        const events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
          { type: "app_thread.created", driver, appThread: thread },
          {
            type: "node.updated",
            driver,
            node: {
              id: rootNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          // Last, as both adapters send it: the task that makes the subagent a caller.
          { type: "subagent.updated", driver, subagent: task },
        ];
        return { task, thread, rootNodeId, events };
      };
      const project = (turn: StartedTurn, natives: ReadonlyArray<ReturnType<typeof nativeTask>>) =>
        Effect.gen(function* () {
          const last = natives.at(-1)!;
          const projected = yield* watch(
            (event) => event.type === "subagent.updated" && event.payload.id === last.task.id,
          );
          for (const event of natives.flatMap((native) => native.events)) {
            yield* Queue.offer(turn.events, event);
          }
          yield* Fiber.join(projected);
        });
      const finishTurn = (turn: StartedTurn, status: "completed" | "failed" = "completed") =>
        Effect.gen(function* () {
          const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.turn.attemptId}`);
          const ended = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === turn.turn.runId &&
              event.payload.status !== "running" &&
              event.payload.status !== "starting",
          );
          const terminal: ProviderAdapter.ProviderAdapterV2Event =
            status === "completed"
              ? {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.turn.runOrdinal,
                  status,
                  failure: null,
                  threadDisposition: "reusable",
                }
              : {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.turn.runOrdinal,
                  failureItemOrdinal: 1,
                  status,
                  failure: {
                    class: "provider_error",
                    message: "The task broke.",
                    code: null,
                    retryable: false,
                  },
                  threadDisposition: "reusable",
                };
          for (const event of [
            {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: turn.turn.providerThread.id,
                nodeId: turn.turn.rootNodeId,
                runAttemptId: turn.turn.attemptId,
                nativeTurnRef: null,
                ordinal: turn.turn.providerTurnOrdinal,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            terminal,
          ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) {
            yield* Queue.offer(turn.events, event);
          }
          yield* Fiber.join(ended);
          yield* worker.drain();
        });
      const delegate = (
        scope: McpThreadInvocationScope,
        clientRequestId: string,
        options: { readonly mode?: "async" | "wait"; readonly timeoutMs?: number } = {},
      ) =>
        service
          .delegateTask(scope, {
            task: `Delegated by ${scope.thread.nativeCallId ?? scope.thread.threadId}`,
            mode: options.mode ?? "async",
            clientRequestId,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          })
          .pipe(Effect.tap(() => worker.drain()));
      const listed = (threadId: ThreadId, taskId: NodeId) =>
        orchestrator.getThreadProjection(threadId).pipe(
          Effect.map((projection) => ({
            projection,
            task: projection.subagents.find((task) => task.id === taskId),
          })),
        );
      const childTurn = (threadId: ThreadId | null) =>
        turns.findLast((entry) => entry.turn.threadId === threadId)!;
      const nextStreamCall = (predicate: (call: StreamCall) => boolean) =>
        Effect.gen(function* () {
          while (true) {
            const call = yield* Queue.take(streamCalls);
            if (predicate(call)) return call;
          }
        });
      return {
        orchestrator,
        worker,
        eventSink,
        service,
        mcpSessions,
        threads,
        questions,
        turns,
        stops,
        interrupts,
        watch,
        taskSettles,
        startRoot,
        nativeTask,
        project,
        finishTurn,
        delegate,
        listed,
        childTurn,
        nextStreamCall,
        nextCallerResolution: (callId: string) =>
          Stream.fromQueue(callerResolutions).pipe(
            Stream.filter((resolved) => resolved === callId),
            Stream.runHead,
          ),
      };
    }).pipe(Effect.provide(context));
  });

const sessionFor = (threadId: ThreadId, providerSessionId: string) => ({
  environmentId: EnvironmentId.make("environment:native-delegation"),
  threadId,
  providerSessionId,
  providerInstanceId: instanceId,
  endpoint: "http://127.0.0.1/mcp",
  authorizationHeader: "Bearer token",
  browserToolsAvailable: false,
});

const scopeFor = (
  threadId: ThreadId,
  providerSessionId: string,
  nativeCallId?: string,
): McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:native-delegation"),
  requestNamespace: providerSessionId,
  thread: {
    threadId,
    providerSessionId,
    providerInstanceId: instanceId,
    ...(nativeCallId === undefined ? {} : { nativeCallId }),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

it.effect(
  "native subagents delegate from their own threads while the root run executes the tasks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness("native-subagent-delegation");
        const credential = "provider-session:native-delegation";
        const rootThreadId = ThreadId.make("thread:native-delegation-root");
        const root = yield* h.startRoot(rootThreadId, credential);
        const execution = { threadId: rootThreadId, runId: root.run.id };

        // Claude's adapter projects native subagents A and B at depth 1, and C under A.
        const a = h.nativeTask({
          name: "a",
          listing: {
            ...root.projection.thread,
            branch: "before-workspace-change",
            worktreePath: "/tmp/t3code-28873-review-followup/stale-native-workspace",
          },
          parentNodeId: root.run.rootNodeId!,
          execution,
        });
        const b = h.nativeTask({
          name: "b",
          listing: root.projection.thread,
          parentNodeId: root.run.rootNodeId!,
          execution,
        });
        const c = h.nativeTask({
          name: "c",
          listing: a.thread,
          parentNodeId: a.rootNodeId,
          execution,
        });
        yield* h.project(root.turn, [a, b, c]);

        // The adapter binds each T3 tool call to the agent that made it.
        for (const [callId, callerThreadId] of [
          ["claude-tool:root", rootThreadId],
          ["claude-tool:a", a.thread.id],
          ["claude-tool:b", b.thread.id],
          ["claude-tool:c", c.thread.id],
          ["claude-tool:foreign", ThreadId.make("thread:somewhere-else")],
        ] as const) {
          yield* h.mcpSessions.bindNativeCaller({
            threadId: rootThreadId,
            providerSessionId: credential,
            callId,
            callerThreadId,
          });
        }
        const scope = (nativeCallId?: string) => scopeFor(rootThreadId, credential, nativeCallId);

        // Siblings with equal request keys get their own tasks, each listed by its caller.
        const fromA = yield* h.delegate(scope("claude-tool:a"), "same-key");
        const delegatedThread = (yield* h.orchestrator.getThreadProjection(fromA.childThreadId!))
          .thread;
        assert.equal(delegatedThread.projectId, root.projection.thread.projectId);
        assert.equal(delegatedThread.branch, root.projection.thread.branch);
        assert.equal(delegatedThread.worktreePath, root.projection.thread.worktreePath);
        const fromB = yield* h.delegate(scope("claude-tool:b"), "same-key");
        const fromC = yield* h.delegate(scope("claude-tool:c"), "same-key");
        const fromRoot = yield* h.delegate(scope(), "same-key");
        const retriedA = yield* h.delegate(scope("claude-tool:a"), "same-key");
        assert.equal(retriedA.taskId, fromA.taskId, "a retry by the same caller is the same task");
        assert.equal(new Set([fromA.taskId, fromB.taskId, fromC.taskId, fromRoot.taskId]).size, 4);
        for (const [caller, delegated] of [
          [a, fromA],
          [b, fromB],
          [c, fromC],
        ] as const) {
          const { projection, task } = yield* h.listed(caller.thread.id, delegated.taskId);
          assert.isDefined(task, `${caller.task.title} lists its own task`);
          assert.equal(task.runId, root.run.id, "the root run executes it");
          assert.equal(task.executionThreadId, rootThreadId);
          assert.equal(task.parentNodeId, caller.rootNodeId);
          assert.isNull(projection.nodes.find((node) => node.id === task.id)?.runId);
          assert.equal(
            projection.turnItems.find(
              (item) => item.type === "subagent" && item.subagentId === task.id,
            )?.threadId,
            caller.thread.id,
          );
          const child = yield* h.orchestrator.getThreadProjection(delegated.childThreadId!);
          assert.equal(child.thread.lineage.parentThreadId, caller.thread.id);
        }
        const rootAfter = yield* h.orchestrator.getThreadProjection(rootThreadId);
        assert.deepEqual(
          rootAfter.subagents.filter((task) => task.origin === "app_owned").map((task) => task.id),
          [fromRoot.taskId],
          "the root lists only its own delegation",
        );

        // A caller that is not a native subagent of this session is refused, as is an unbound one.
        const foreign = yield* Effect.forkChild(
          Effect.exit(h.delegate(scope("claude-tool:foreign"), "foreign")),
        );
        const foreignWaits = yield* Effect.raceFirst(
          h.nextStreamCall((call) => call?.eventType === "subagent.updated").pipe(Effect.as(true)),
          Fiber.await(foreign).pipe(Effect.as(false)),
        );
        if (foreignWaits) yield* TestClock.adjust("5 seconds");
        assert.isTrue(Exit.isFailure(yield* Fiber.join(foreign)));
        const unbound = yield* Effect.forkChild(
          Effect.exit(h.delegate(scope("claude-tool:nobody"), "x")),
        );
        yield* h.nextCallerResolution("claude-tool:nobody");
        yield* TestClock.adjust("5 seconds");
        assert.isTrue(Exit.isFailure(yield* Fiber.join(unbound)));

        // A subagent can call before the provider's events about it are stored.
        const d = h.nativeTask({
          name: "d",
          listing: root.projection.thread,
          parentNodeId: root.run.rootNodeId!,
          execution,
        });
        yield* h.mcpSessions.bindNativeCaller({
          threadId: rootThreadId,
          providerSessionId: credential,
          callId: "claude-tool:d",
          callerThreadId: d.thread.id,
        });
        const early = yield* Effect.forkChild(h.delegate(scope("claude-tool:d"), "early"));
        const waiting = yield* Effect.raceFirst(
          h
            .nextStreamCall((call) => call?.eventType === "subagent.updated")
            .pipe(Effect.as("waiting for its records" as const)),
          Fiber.await(early).pipe(Effect.as("answered before its records" as const)),
        );
        assert.equal(waiting, "waiting for its records");
        yield* h.project(root.turn, [d]);
        const fromD = yield* Fiber.join(early);
        assert.isDefined((yield* h.listed(d.thread.id, fromD.taskId)).task);

        // Each caller reads and cancels only its own tasks; the root reads those its run executes.
        assert.equal(
          (yield* h.service.taskStatus(scope("claude-tool:a"), fromA.taskId)).status,
          "running",
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(h.service.taskStatus(scope("claude-tool:b"), fromA.taskId)),
          ),
        );
        assert.equal((yield* h.service.taskStatus(scope(), fromC.taskId)).status, "running");
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              h.service.cancelTask(scope("claude-tool:b"), { taskId: fromA.taskId }),
            ),
          ),
        );

        // A's task finishes: its result lands in A's thread and the root run is woken for it.
        const settledA = yield* h.taskSettles(fromA.taskId);
        yield* h.finishTurn(h.childTurn(fromA.childThreadId));
        yield* Fiber.join(settledA);
        const finished = yield* h.listed(a.thread.id, fromA.taskId);
        assert.equal(finished.task?.completionDelivery?.state, "claimed");
        assert.isTrue(
          finished.projection.contextTransfers.some(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === fromA.childThreadId &&
              transfer.targetThreadId === a.thread.id,
          ),
        );
        const woken = (yield* h.orchestrator.getThreadProjection(rootThreadId)).runs.find(
          (run) => run.id === root.run.id,
        );
        assert.deepEqual(woken?.delegatedCompletion?.delivery?.taskIds, [fromA.taskId]);
        assert.equal(
          (yield* h.service.taskStatus(scope("claude-tool:a"), fromA.taskId)).status,
          "completed",
        );

        // The root's follow-up to A's child is a new task, still listed by A and run by the root.
        yield* h.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("follow-up-a"),
          threadId: fromA.childThreadId!,
          messageId: MessageId.make("message:follow-up-a"),
          senderThreadId: rootThreadId,
          text: "One more thing",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* h.worker.drain();
        const followUp = (yield* h.orchestrator.getThreadProjection(a.thread.id)).subagents.find(
          (task) =>
            task.origin === "app_owned" &&
            task.childThreadId === fromA.childThreadId &&
            task.id !== fromA.taskId,
        );
        assert.isDefined(followUp);
        assert.equal(followUp.runId, root.run.id);
        assert.equal(followUp.executionThreadId, rootThreadId);
        assert.equal(followUp.parentNodeId, a.rootNodeId);

        // C's Stop reaches the root's session though C is listed in A's thread.
        yield* h.orchestrator.dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("stop-nested-native"),
          threadId: a.thread.id,
          runId: root.run.id,
          subagentId: c.task.id,
        });
        yield* h.worker.drain();
        assert.deepEqual(h.stops, [{ appThreadId: rootThreadId, nativeTaskId: "task-c" }]);
        assert.equal(
          (yield* h.listed(a.thread.id, c.task.id)).task?.status,
          "cancelled",
          "the confirmed outcome settles C where it is listed",
        );

        // A wait that times out lets B's later result wake the root after all.
        const waited = yield* Effect.forkChild(
          h.delegate(scope("claude-tool:b"), "wait-b", { mode: "wait", timeoutMs: 1_000 }),
        );
        yield* h.nextStreamCall((call) => call?.threadId === b.thread.id);
        yield* TestClock.adjust("1 second");
        const waitedB = yield* Fiber.join(waited);
        assert.isTrue(waitedB.waitTimedOut);
        assert.equal((yield* h.listed(b.thread.id, waitedB.taskId)).task?.completionWake, "always");

        // Its failure joins the unread result in the root's completion notice.
        const settledB = yield* h.taskSettles(waitedB.taskId);
        yield* h.finishTurn(h.childTurn(waitedB.childThreadId), "failed");
        yield* Fiber.join(settledB);
        yield* h.finishTurn(root.turn);
        const notice = (yield* h.orchestrator.getThreadProjection(rootThreadId)).turnItems.find(
          (item) =>
            item.type === "notification" &&
            item.source.kind === "delegated_task" &&
            item.source.taskIds.includes(waitedB.taskId),
        );
        assert.deepInclude(notice, {
          outcome: "failed",
          source: {
            kind: "delegated_task",
            taskIds: [fromA.taskId, waitedB.taskId],
          },
        });

        // A follow-up B listed whose child never ran for it: Stop has nothing else to end it.
        const orphan: OrchestrationV2Subagent = {
          ...(yield* h.listed(b.thread.id, waitedB.taskId)).task!,
          id: NodeId.make("node:orphaned-follow-up"),
          status: "running",
          result: null,
          completedAt: null,
          completionWake: "always",
          completionDelivery: undefined,
        };
        yield* h.eventSink.write({
          commandId: CommandId.make("seed-orphaned-follow-up"),
          events: [
            {
              id: EventId.make("event:orphaned-follow-up"),
              type: "subagent.updated",
              threadId: b.thread.id,
              runId: root.run.id,
              nodeId: orphan.id,
              occurredAt: orphan.updatedAt,
              payload: orphan,
            },
          ],
        });

        // Root Stop reaches what its native subagents delegated, through the effect worker.
        yield* h.orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-root"),
          threadId: rootThreadId,
        });
        yield* h.worker.drain();
        for (const delegated of [fromRoot, fromC, fromD]) {
          assert.include(h.interrupts, delegated.childThreadId, `${delegated.taskId} was stopped`);
        }
        assert.equal(
          (yield* h.listed(b.thread.id, orphan.id)).task?.status,
          "cancelled",
          "Stop cancels the idle orphan where it is listed",
        );
      }),
    ),
);

it.effect("an app task waits for its child's nested native work and tasks, then its answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("mixed-delegation-chain");
      const rootThreadId = ThreadId.make("thread:mixed-root");
      const rootScope = scopeFor(rootThreadId, "provider-session:mixed-root");
      yield* h.startRoot(rootThreadId, "provider-session:mixed-root");
      const outer = yield* h.delegate(rootScope, "outer");
      const sentinel = yield* h.delegate(rootScope, "sentinel");
      const wakeSentinel = yield* h.delegate(rootScope, "wake-sentinel");
      const outerThreadId = outer.childThreadId!;
      const outerTurn = h.childTurn(outerThreadId);
      const child = yield* h.orchestrator.getThreadProjection(outerThreadId);
      const childRun = child.runs[0]!;
      yield* h.mcpSessions.set(sessionFor(outerThreadId, "provider-session:mixed-child"));

      // The outer task's child runs a native subagent, which delegates and runs its own.
      const native = h.nativeTask({
        name: "mixed",
        listing: child.thread,
        parentNodeId: childRun.rootNodeId!,
        execution: { threadId: outerThreadId, runId: childRun.id },
      });
      const nested = h.nativeTask({
        name: "mixed-nested",
        listing: native.thread,
        parentNodeId: native.rootNodeId,
        execution: { threadId: outerThreadId, runId: childRun.id },
      });
      yield* h.project(outerTurn, [native, nested]);
      yield* h.mcpSessions.bindNativeCaller({
        threadId: outerThreadId,
        providerSessionId: "provider-session:mixed-child",
        callId: "claude-tool:mixed",
        callerThreadId: native.thread.id,
      });
      const inner = yield* h.delegate(
        scopeFor(outerThreadId, "provider-session:mixed-child", "claude-tool:mixed"),
        "inner",
      );
      const listedInner = (yield* h.listed(native.thread.id, inner.taskId)).task;
      assert.equal(listedInner?.executionThreadId, outerThreadId);
      assert.equal(listedInner?.runId, childRun.id);

      // The native subagent and then the child's turn end while the inner task still runs.
      yield* Queue.offer(outerTurn.events, {
        type: "subagent.updated",
        driver,
        subagent: {
          ...native.task,
          status: "completed",
          result: "Delegated it.",
          completedAt: native.task.startedAt,
        },
      });
      yield* h.finishTurn(outerTurn);
      // Run ends are handled in order: once the sentinel settles, the child's end was handled.
      const sentinelSettles = yield* h.taskSettles(sentinel.taskId);
      yield* h.finishTurn(h.childTurn(sentinel.childThreadId));
      yield* Fiber.join(sentinelSettles);
      const waiting = yield* h.service.taskStatus(rootScope, outer.taskId);
      assert.equal(waiting.workState, "waiting_for_children");
      assert.isNull((yield* h.listed(rootThreadId, outer.taskId)).task?.result ?? null);

      // The inner result wakes the child, and the outer task completes with that answer.
      const woken = yield* h.watch(
        (event) =>
          event.type === "run.created" &&
          event.threadId === outerThreadId &&
          event.payload.id !== childRun.id,
      );
      yield* h.finishTurn(h.childTurn(inner.childThreadId));
      yield* Fiber.join(woken);
      yield* h.worker.drain();
      const wakeTurn = h.childTurn(outerThreadId);
      assert.notStrictEqual(wakeTurn, outerTurn);
      assert.isNull((yield* h.listed(rootThreadId, outer.taskId)).task?.result ?? null);

      // The wake ends while the nested native subagent still runs, so the answer waits for it.
      const wakeSentinelSettles = yield* h.taskSettles(wakeSentinel.taskId);
      yield* h.finishTurn(wakeTurn);
      yield* h.finishTurn(h.childTurn(wakeSentinel.childThreadId));
      yield* Fiber.join(wakeSentinelSettles);
      assert.equal((yield* h.listed(nested.task.threadId, nested.task.id)).task?.status, "running");
      const nestedWaiting = yield* h.service.taskStatus(rootScope, outer.taskId);
      assert.equal(nestedWaiting.workState, "waiting_for_children");
      assert.isNull((yield* h.listed(rootThreadId, outer.taskId)).task?.result ?? null);

      const settled = yield* h.taskSettles(outer.taskId);
      yield* Queue.offer(outerTurn.events, {
        type: "subagent.updated",
        driver,
        subagent: {
          ...nested.task,
          status: "completed",
          result: "Nested work done.",
          completedAt: nested.task.startedAt,
        },
      });
      yield* Fiber.join(settled);
      assert.equal((yield* h.listed(rootThreadId, outer.taskId)).task?.status, "completed");
    }),
  ),
);

it.effect("Stop on a settled root leaves its native subagents' tasks nothing to wake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("settled-root-stop");
      const rootThreadId = ThreadId.make("thread:settled-root");
      const root = yield* h.startRoot(rootThreadId, "provider-session:settled-root");
      const native = h.nativeTask({
        name: "settled",
        listing: root.projection.thread,
        parentNodeId: root.run.rootNodeId!,
        execution: { threadId: rootThreadId, runId: root.run.id },
      });
      yield* h.project(root.turn, [native]);
      yield* h.mcpSessions.bindNativeCaller({
        threadId: rootThreadId,
        providerSessionId: "provider-session:settled-root",
        callId: "claude-tool:settled",
        callerThreadId: native.thread.id,
      });
      const task = yield* h.delegate(
        scopeFor(rootThreadId, "provider-session:settled-root", "claude-tool:settled"),
        "settled",
      );
      yield* h.finishTurn(root.turn);

      // Stop's sweep interrupts the task's child, which settles the task after Stop committed.
      const settled = yield* h.taskSettles(task.taskId);
      yield* h.orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-settled-root"),
        threadId: rootThreadId,
      });
      yield* h.worker.drain();
      assert.include(h.interrupts, task.childThreadId);
      yield* Fiber.join(settled);
      assert.equal(
        (yield* h.listed(native.thread.id, task.taskId)).task?.completionDelivery?.state,
        "disposed",
      );
      const rootRun = (yield* h.orchestrator.getThreadProjection(rootThreadId)).runs.find(
        (run) => run.id === root.run.id,
      );
      assert.isNull(rootRun?.delegatedCompletion?.delivery ?? null);
    }),
  ),
);

it.effect("a stopped app child's task ends once what its native subagent delegated settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("stopped-mixed-chain");
      const rootThreadId = ThreadId.make("thread:stopped-mixed-root");
      const rootScope = scopeFor(rootThreadId, "provider-session:stopped-mixed-root");
      yield* h.startRoot(rootThreadId, "provider-session:stopped-mixed-root");
      const outer = yield* h.delegate(rootScope, "outer");
      const outerThreadId = outer.childThreadId!;
      const child = yield* h.orchestrator.getThreadProjection(outerThreadId);
      const childRun = child.runs[0]!;
      yield* h.mcpSessions.set(sessionFor(outerThreadId, "provider-session:stopped-mixed-child"));
      const native = h.nativeTask({
        name: "stopped-mixed",
        listing: child.thread,
        parentNodeId: childRun.rootNodeId!,
        execution: { threadId: outerThreadId, runId: childRun.id },
      });
      yield* h.project(h.childTurn(outerThreadId), [native]);
      yield* h.mcpSessions.bindNativeCaller({
        threadId: outerThreadId,
        providerSessionId: "provider-session:stopped-mixed-child",
        callId: "claude-tool:stopped-mixed",
        callerThreadId: native.thread.id,
      });
      const inner = yield* h.delegate(
        scopeFor(
          outerThreadId,
          "provider-session:stopped-mixed-child",
          "claude-tool:stopped-mixed",
        ),
        "inner",
      );

      // Run updates are handled in order, so the child's own end sees the inner task still
      // running; with its wake disposed by Stop, only the inner task settling ends the outer.
      const innerSettles = yield* h.taskSettles(inner.taskId);
      const outerSettles = yield* h.taskSettles(outer.taskId);
      yield* h.orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-mixed-child"),
        threadId: outerThreadId,
      });
      yield* h.worker.drain();
      yield* Fiber.join(innerSettles);
      yield* Fiber.join(outerSettles);
      const ended = (yield* h.listed(rootThreadId, outer.taskId)).task;
      assert.equal(ended?.status, "interrupted");
    }),
  ),
);

it.effect.each(["runtime", "interaction", "unchanged"] as const)(
  "cancelling a task checks what its native subagent delegated before stopping it: %s",
  (raised) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(`cancel-native-delegated-${raised}`);
        const rootThreadId = ThreadId.make("thread:cancel-native-root");
        const rootScope = scopeFor(rootThreadId, "provider-session:cancel-native-root");
        yield* h.startRoot(rootThreadId, "provider-session:cancel-native-root", {
          runtimeMode: "auto",
          interactionMode: "plan",
        });
        const outer = yield* h.delegate(rootScope, "outer");
        const outerThreadId = outer.childThreadId!;
        const child = yield* h.orchestrator.getThreadProjection(outerThreadId);
        const childRun = child.runs[0]!;
        yield* h.mcpSessions.set(sessionFor(outerThreadId, "provider-session:cancel-native-child"));
        const native = h.nativeTask({
          name: "cancel-native",
          listing: child.thread,
          parentNodeId: childRun.rootNodeId!,
          execution: { threadId: outerThreadId, runId: childRun.id },
        });
        yield* h.project(h.childTurn(outerThreadId), [native]);
        yield* h.mcpSessions.bindNativeCaller({
          threadId: outerThreadId,
          providerSessionId: "provider-session:cancel-native-child",
          callId: "claude-tool:cancel-native",
          callerThreadId: native.thread.id,
        });
        const inner = yield* h.delegate(
          scopeFor(
            outerThreadId,
            "provider-session:cancel-native-child",
            "claude-tool:cancel-native",
          ),
          "inner",
        );
        const innerThreadId = inner.childThreadId!;
        // The inner task's user raises its thread above the root's modes.
        if (raised !== "unchanged") {
          yield* h.orchestrator.dispatch(
            raised === "runtime"
              ? {
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make("raise-inner-runtime"),
                  threadId: innerThreadId,
                  runtimeMode: "full-access",
                }
              : {
                  type: "thread.interaction-mode.set",
                  commandId: CommandId.make("raise-inner-interaction"),
                  threadId: innerThreadId,
                  interactionMode: "default",
                },
          );
          yield* h.worker.drain();
        }

        const cancelled = yield* h.service
          .cancelTask(rootScope, { taskId: outer.taskId, clientRequestId: "cancel" })
          .pipe(
            Effect.match({
              onFailure: (error) => error.code,
              onSuccess: (result) => result.status,
            }),
          );
        yield* h.worker.drain();
        const latestStatus = (threadId: ThreadId) =>
          h.orchestrator
            .getThreadProjection(threadId)
            .pipe(Effect.map((projection) => projection.runs.at(-1)?.status));
        if (raised === "unchanged") {
          assert.equal(cancelled, "cancel_requested");
          assert.equal(yield* latestStatus(outerThreadId), "interrupted");
          assert.equal(yield* latestStatus(innerThreadId), "interrupted");
          return;
        }
        assert.equal(cancelled, `${raised}_mode_escalation_denied`);
        assert.notInclude(h.interrupts, outerThreadId, "nothing is stopped before the refusal");
        assert.equal(yield* latestStatus(outerThreadId), "running");
        assert.equal(yield* latestStatus(innerThreadId), "running");
      }),
    ),
);

it.effect.each([
  ["root", "runtime"],
  ["root", "interaction"],
  ["root", "unchanged"],
  ["native", "runtime"],
  ["native", "interaction"],
  ["native", "unchanged"],
] as const)(
  "cancelling a native subagent's task is limited by the root's current modes: %s caller, %s lowered",
  ([caller, lowered]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(`cancel-native-listed-${caller}-${lowered}`);
        const credential = "provider-session:cancel-native-listed";
        const rootThreadId = ThreadId.make("thread:cancel-native-listed-root");
        const root = yield* h.startRoot(rootThreadId, credential);
        const native = h.nativeTask({
          name: "lister",
          listing: root.projection.thread,
          parentNodeId: root.run.rootNodeId!,
          execution: { threadId: rootThreadId, runId: root.run.id },
        });
        yield* h.project(root.turn, [native]);
        yield* h.mcpSessions.bindNativeCaller({
          threadId: rootThreadId,
          providerSessionId: credential,
          callId: "claude-tool:lister",
          callerThreadId: native.thread.id,
        });
        const nativeScope = scopeFor(rootThreadId, credential, "claude-tool:lister");
        const task = yield* h.delegate(nativeScope, "listed");
        const taskThreadId = task.childThreadId!;
        // The root's user lowers only the root; the native subagent and its task keep theirs.
        if (lowered !== "unchanged") {
          yield* h.orchestrator.dispatch(
            lowered === "runtime"
              ? {
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make("lower-root-runtime"),
                  threadId: rootThreadId,
                  runtimeMode: "approval-required",
                }
              : {
                  type: "thread.interaction-mode.set",
                  commandId: CommandId.make("lower-root-interaction"),
                  threadId: rootThreadId,
                  interactionMode: "plan",
                },
          );
          yield* h.worker.drain();
        }

        const cancelled = yield* h.service
          .cancelTask(caller === "root" ? scopeFor(rootThreadId, credential) : nativeScope, {
            taskId: task.taskId,
            clientRequestId: "cancel",
          })
          .pipe(
            Effect.match({
              onFailure: (error) => error.code,
              onSuccess: (result) => result.status,
            }),
          );
        yield* h.worker.drain();
        const latestStatus = (threadId: ThreadId) =>
          h.orchestrator
            .getThreadProjection(threadId)
            .pipe(Effect.map((projection) => projection.runs.at(-1)?.status));
        if (lowered === "unchanged") {
          assert.equal(cancelled, "cancel_requested");
          assert.equal(yield* latestStatus(taskThreadId), "interrupted");
          return;
        }
        assert.equal(cancelled, `${lowered}_mode_escalation_denied`);
        assert.notInclude(h.interrupts, taskThreadId, "nothing is stopped before the refusal");
        assert.equal(yield* latestStatus(taskThreadId), "running");
        assert.equal(yield* latestStatus(rootThreadId), "running");
      }),
    ),
);

it.effect.each(["runtime", "interaction", "unchanged"] as const)(
  "a native subagent delegates within its own modes, not only the root's: %s lowered",
  (lowered) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(`native-delegate-modes-${lowered}`);
        const credential = "provider-session:native-delegate-modes";
        const rootThreadId = ThreadId.make("thread:native-delegate-modes-root");
        const root = yield* h.startRoot(rootThreadId, credential);
        const native = h.nativeTask({
          name: "lowered",
          listing: root.projection.thread,
          parentNodeId: root.run.rootNodeId!,
          execution: { threadId: rootThreadId, runId: root.run.id },
        });
        yield* h.project(root.turn, [native]);
        yield* h.mcpSessions.bindNativeCaller({
          threadId: rootThreadId,
          providerSessionId: credential,
          callId: "claude-tool:lowered",
          callerThreadId: native.thread.id,
        });
        // The native subagent's user lowers only its thread; the root keeps full-access/default.
        if (lowered !== "unchanged") {
          yield* h.orchestrator.dispatch(
            lowered === "runtime"
              ? {
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make("lower-native-runtime"),
                  threadId: native.thread.id,
                  runtimeMode: "approval-required",
                }
              : {
                  type: "thread.interaction-mode.set",
                  commandId: CommandId.make("lower-native-interaction"),
                  threadId: native.thread.id,
                  interactionMode: "plan",
                },
          );
          yield* h.worker.drain();
        }
        const nativeScope = scopeFor(rootThreadId, credential, "claude-tool:lowered");

        const inherited = yield* h.delegate(nativeScope, "inherited");
        const child = yield* h.orchestrator.getThreadProjection(inherited.childThreadId!);
        assert.deepEqual(
          { runtimeMode: child.thread.runtimeMode, interactionMode: child.thread.interactionMode },
          {
            runtimeMode: lowered === "runtime" ? "approval-required" : "full-access",
            interactionMode: lowered === "interaction" ? "plan" : "default",
          },
        );

        const explicit = yield* h.service
          .delegateTask(nativeScope, {
            task: "Broader",
            mode: "async",
            clientRequestId: "explicit",
            runtimeMode: "full-access",
            interactionMode: "default",
          })
          .pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => "delegated" }));
        yield* h.worker.drain();
        const listedTasks = (yield* h.orchestrator.getThreadProjection(native.thread.id)).subagents;
        if (lowered === "unchanged") {
          assert.equal(explicit, "delegated");
          assert.lengthOf(listedTasks, 2);
          return;
        }
        assert.equal(explicit, `${lowered}_mode_escalation_denied`);
        assert.deepEqual(
          listedTasks.map((task) => task.id),
          [inherited.taskId],
          "a refused delegation creates no task",
        );
      }),
    ),
);

it.effect.each(["active", "archived", "deleted"] as const)(
  "a native task's question wakes only its active execution thread: %s",
  (executionState) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness("native-delegation-question");
        const rootThreadId = ThreadId.make("thread:question-root");
        const root = yield* h.startRoot(rootThreadId, "provider-session:question-root");
        const native = h.nativeTask({
          name: "asker",
          listing: root.projection.thread,
          parentNodeId: root.run.rootNodeId!,
          execution: { threadId: rootThreadId, runId: root.run.id },
        });
        yield* h.project(root.turn, [native]);
        yield* h.mcpSessions.bindNativeCaller({
          threadId: rootThreadId,
          providerSessionId: "provider-session:question-root",
          callId: "claude-tool:asker",
          callerThreadId: native.thread.id,
        });
        const task = yield* h.delegate(
          scopeFor(rootThreadId, "provider-session:question-root", "claude-tool:asker"),
          "asker",
        );
        const childRun = (yield* h.orchestrator.getThreadProjection(task.childThreadId!)).runs[0]!;
        const now = yield* DateTime.now;
        if (executionState !== "active") {
          const execution = (yield* h.orchestrator.getThreadProjection(rootThreadId)).thread;
          yield* h.eventSink.write({
            events: [
              {
                id: EventId.make("event:inactive-question-execution"),
                type: "thread.metadata-updated",
                threadId: rootThreadId,
                occurredAt: now,
                payload: {
                  ...execution,
                  ...(executionState === "archived" ? { archivedAt: now } : { deletedAt: now }),
                },
              },
            ],
          });
        }
        const question = {
          id: EventId.make("event:native-task-question"),
          type: "runtime-request.updated",
          threadId: task.childThreadId!,
          runId: childRun.id,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:native-task-question"),
            nodeId: childRun.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        } satisfies OrchestrationV2DomainEvent;
        yield* h.eventSink.write({ events: [question] });
        yield* h.questions.handle(question);
        const wake = (yield* h.orchestrator.getThreadProjection(rootThreadId)).messages.find(
          (message) => message.notification?.source.kind === "delegated_task",
        );
        if (executionState === "active") {
          assert.deepEqual(wake?.notification?.source, {
            kind: "delegated_task",
            taskIds: [task.taskId],
            childThreadId: task.childThreadId!,
          });
        } else {
          assert.isUndefined(wake);
        }
      }),
    ),
);
