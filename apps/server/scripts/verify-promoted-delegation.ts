// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off - Operational evidence runner owns its artifact output.
// Run from the repository root: node apps/server/scripts/verify-promoted-delegation.ts
// Headless server-service evidence only: no listening server, UI, live inference, or process restart.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSubagentConversationArtifacts } from "@t3tools/provider-core/server/subagentProjection";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Harness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Orchestrator from "../src/orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../src/orchestration-v2/EffectWorker.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ThreadManagement from "../src/orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../src/orchestration-v2/ThreadLaunchService.ts";
import * as Mcp from "../src/mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../src/mcp/McpInvocationContext.ts";
import * as GitDriver from "../src/vcs/GitVcsDriver.ts";
import * as Providers from "../src/provider/ProviderRegistry.ts";
import * as Projects from "../src/project/ProjectService.ts";
import * as Secrets from "../src/secrets/SecretRequests.ts";
import * as Scheduled from "../src/scheduledTasks/ScheduledTaskService.ts";
import * as Settings from "../src/serverSettings.ts";

const output = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-promoted-delegation-"));
const root = NodePath.resolve(import.meta.dirname, "../../..");
const revision = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const changed = NodeChildProcess.execFileSync("git", ["diff", "--name-only", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const trace = (value: unknown) =>
  NodeFS.appendFileSync(NodePath.join(output, "trace.ndjson"), JSON.stringify(value) + "\n");
NodeFS.writeFileSync(
  NodePath.join(output, "manifest.json"),
  JSON.stringify(
    {
      revision,
      productionRevision: NodeChildProcess.execFileSync(
        "git",
        ["log", "-1", "--format=%H", "--", "apps/server/src/orchestration-v2/Orchestrator.ts"],
        { cwd: root, encoding: "utf8" },
      ).trim(),
      fixtureSha256: NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(import.meta.filename))
        .digest("hex"),
      changed,
      evidence: "headless actual server services / deterministic adapter / in-memory SQLite",
      command: "node apps/server/scripts/verify-promoted-delegation.ts",
      missing: [
        "UI",
        "live provider",
        "real process restart",
        "native clients",
        "task_wait (not exposed by this revision; mode=wait cannot address a follow-up task)",
        "queue-held/idle opening",
        "synthetic restart chain",
        "unpromoted cancellation and interrupted/waiting boundary controls",
      ],
    },
    null,
    2,
  ),
);
console.log(`Evidence: ${output}`);
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

const run = (owner: "delegated" | "monitor", outcome: "completed" | "failed") =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `${owner}-${outcome}`;
      const cwd = yield* checkpointWorkspace(`promoted-${name}`);
      const started = new Map<ThreadId, ProviderAdapter.ProviderAdapterV2TurnInput[]>();
      const queues = new Map<ThreadId, Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>>();
      const steered = yield* Deferred.make<void>();
      const capabilities = CodexProviderCapabilitiesV2;
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: Effect.fn("PromotedFixture.openSession")(function* (
          input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
        ): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2SessionRuntime> {
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
              Effect.sync(() => {
                queues.set(threadId, events);
                return {
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: `native:${threadId}`,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef: null,
                  status: "idle" as const,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                };
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: Effect.fn("PromotedFixture.startTurn")(function* (
              turn: ProviderAdapter.ProviderAdapterV2TurnInput,
            ) {
              started.set(turn.threadId, [...(started.get(turn.threadId) ?? []), turn]);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
            steerTurn: () => Deferred.succeed(steered, undefined).pipe(Effect.asVoid),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused snapshot"),
            rollbackThread: () => Effect.die("unused rollback"),
            forkThread: () => Effect.die("unused fork"),
          };
        }),
      };
      const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
        get: () => Effect.succeed(adapter),
        list: () => Effect.succeed([instanceId]),
      });
      const runtime = Harness.layerWithRegistry({ name: `promoted-${name}` }, registry, {
        runEffectWorker: false,
      });
      // The replay harness owns the real runtime. This facade forwards only reads/commands;
      // unrelated launch, secrets, scheduling and provider discovery must never be exercised.
      const threads = Layer.unwrap(
        Effect.gen(function* () {
          const o = yield* Orchestrator.OrchestratorV2;
          return Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: o.dispatch,
            getThreadProjection: o.getThreadProjection,
            getThreadShell: o.getThreadShell,
            getThreadRecords: o.getThreadRecords,
            getTimelinePage: o.getTimelinePage,
            getProjectThreadRecords: (input, fields, filter) =>
              o.getThreadRecords(input.threadId, fields, filter),
            recoverDelegatedTask: o.recoverDelegatedTask,
            delegatedTaskResultPending: o.delegatedTaskResultPending,
            streamStoredEvents: o.streamStoredEvents,
            streamStoredEventsFrom: o.streamStoredEventsFrom,
            streamDomainEvents: o.streamDomainEvents,
          });
        }),
      ).pipe(Layer.provide(runtime));
      const mcp = Mcp.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            threads,
            registry,
            Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
            Layer.mock(GitDriver.GitVcsDriver)({}),
            Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(Projects.ProjectService)({}),
            Layer.mock(Secrets.SecretRequests)({}),
            Layer.mock(Scheduled.ScheduledTaskService)({}),
            Settings.layerTest(),
            NodeServices.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const o = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const service = yield* Mcp.OrchestratorMcpService;
        const dispatch: typeof o.dispatch = (command) => {
          trace({ name, stage: "command", command });
          return o.dispatch(command);
        };
        const parent = ThreadId.make(`${name}:parent`);
        const projectId = ProjectId.make(`${name}:project`);
        let sequence = 0;
        const commandId = () => CommandId.make(`${name}:command:${++sequence}`);
        const watch = Effect.fn("PromotedFixture.watch")(function* (
          predicate: (event: OrchestrationV2DomainEvent) => boolean,
        ) {
          const afterSequence = yield* sink.latestSequence();
          yield* o.streamStoredEventsFrom({ afterSequence }).pipe(
            Stream.filter((stored) => predicate(stored.event)),
            Stream.take(1),
            Stream.runDrain,
          );
        });
        const waitRunning = (threadId: ThreadId) =>
          watch(
            (e) =>
              e.threadId === threadId &&
              e.type === "provider-turn.updated" &&
              e.payload.status === "running",
          );
        const start = (
          threadId: ThreadId,
          text: string,
          senderThreadId?: ThreadId,
          notification?: { source: { kind: "monitor" }; outcome: "updated"; summary: string },
        ) =>
          dispatch({
            type: "message.dispatch",
            commandId: commandId(),
            threadId,
            messageId: MessageId.make(`${name}:message:${sequence}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: senderThreadId || notification ? "agent" : "user",
            creationSource: senderThreadId ? "mcp" : "server",
            ...(senderThreadId ? { senderThreadId } : {}),
            ...(notification ? { notification } : {}),
          });
        const finish = Effect.fn("PromotedFixture.finish")(function* (
          threadId: ThreadId,
          status: "completed" | "failed",
          text: string,
        ) {
          const projection = yield* o.getThreadProjection(threadId);
          const turn = projection.providerTurns.find((t) => t.status === "running");
          NodeAssert.ok(turn);
          const input = started.get(threadId)!.at(-1)!;
          const run = projection.runs.find((r) => r.id === input.runId)!;
          const now = yield* DateTime.now;
          const itemId = TurnItemId.make(`${name}:result:${sequence++}`);
          const { message, turnItem } = makeSubagentConversationArtifacts({
            threadId,
            rootNodeId: input.rootNodeId,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            nativeItemRef: null,
            messageId: MessageId.make(`${itemId}:message`),
            turnItemId: itemId,
            role: "assistant",
            text,
            ordinal: 100,
            now,
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${itemId}:message`),
                type: "message.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...message, runId: run.id },
              },
              {
                id: EventId.make(`${itemId}:item`),
                type: "turn-item.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...turnItem, runId: run.id },
              },
            ],
          });
          const waiting = yield* watch(
            (e) =>
              e.type === "run.updated" &&
              e.payload.id === run.id &&
              ["waiting", "failed"].includes(e.payload.status),
          ).pipe(Effect.forkScoped);
          const queue = queues.get(threadId)!;
          yield* Queue.offer(queue, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status, completedAt: now },
          });
          yield* Queue.offer(queue, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: input.runOrdinal,
            ...(status === "failed"
              ? {
                  status,
                  failureItemOrdinal: 101,
                  failure: {
                    class: "provider_error" as const,
                    message: text,
                    code: "fixture_failure",
                    retryable: false,
                  },
                }
              : { status, failure: null }),
            threadDisposition: "reusable",
          });
          trace({ name, stage: "adapter-terminal-offered", status, runId: run.id });
          yield* Fiber.join(waiting);
          yield* worker.drain();
          const final = yield* o.getThreadProjection(threadId);
          const resultItemId =
            status === "failed"
              ? final.turnItems.find((item) => item.type === "error" && item.runId === run.id)!.id
              : itemId;
          return { run, itemId: resultItemId };
        });
        yield* dispatch({
          type: "thread.create",
          commandId: commandId(),
          threadId: parent,
          projectId,
          title: name,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* start(parent, "PARENT_HELD");
        const parentRunning = yield* waitRunning(parent).pipe(Effect.forkScoped);
        yield* worker.drain();
        yield* Fiber.join(parentRunning);
        const parentRun = (yield* o.getThreadProjection(parent)).runs[0]!;
        const delegation = yield* dispatch({
          type: "delegated_task.request",
          commandId: commandId(),
          parentThreadId: parent,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "INITIAL_HELD",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "settled_only",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const taskEvent = delegation.storedEvents.find((e) => e.event.type === "subagent.updated")!;
        NodeAssert.equal(taskEvent.event.type, "subagent.updated");
        if (taskEvent.event.type !== "subagent.updated") throw new Error("missing task");
        const originalTask = taskEvent.event.payload;
        const child = originalTask.childThreadId!;
        const childRunning = yield* waitRunning(child).pipe(Effect.forkScoped);
        yield* worker.drain();
        yield* Fiber.join(childRunning);
        yield* finish(child, "completed", "INITIAL_DONE");
        if (owner === "monitor")
          yield* start(child, "MONITOR_HELD", undefined, {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Fixture monitor output",
          });
        else yield* start(child, "DELEGATED_HELD", parent);
        const nextRunning = yield* waitRunning(child).pipe(Effect.forkScoped);
        yield* worker.drain();
        yield* Fiber.join(nextRunning);
        const active = (yield* o.getThreadProjection(child)).runs.find(
          (r) => r.status === "running",
        )!;
        NodeAssert.ok(active);
        NodeAssert.equal(active.delegatedTaskId === undefined, owner === "monitor");
        yield* start(child, "PROMOTED_HELD", parent);
        const queued = (yield* o.getThreadProjection(child)).runs.find(
          (r) => r.status === "queued",
        )!;
        NodeAssert.ok(queued?.delegatedTaskId);
        const taskId = queued.delegatedTaskId;
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("fixture"),
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
          requestNamespace: name,
          thread: {
            threadId: parent,
            providerSessionId: "fixture",
            providerInstanceId: instanceId,
          },
          client: undefined,
        };
        trace({
          name,
          stage: "queued",
          task: yield* service.taskStatus(scope, taskId),
          activeRunId: active.id,
          queuedRunId: queued.id,
        });
        const beforePromotion = yield* sink.latestSequence();
        yield* dispatch({
          type: "queued-message.promote-to-steer",
          commandId: commandId(),
          threadId: child,
          queuedRunId: queued.id,
          targetRunId: active.id,
        });
        yield* worker.drain();
        yield* Deferred.await(steered);
        yield* o.recoverDelegatedTask(child, queued.id);
        yield* sink.stream({ afterSequence: beforePromotion, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === taskId &&
              stored.event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const working = yield* service.taskStatus(scope, taskId);
        const promotedChild = yield* o.getThreadProjection(child);
        NodeAssert.equal(
          promotedChild.runs.find((run) => run.id === queued.id)?.status,
          "cancelled",
        );
        NodeAssert.equal(
          promotedChild.messages.find((message) => message.id === queued.userMessageId)?.runId,
          active.id,
        );
        NodeAssert.ok(
          promotedChild.turnItems.some(
            (item) =>
              item.type === "user_message" &&
              item.messageId === queued.userMessageId &&
              item.inputIntent === "promoted_queued_to_steer",
          ),
        );
        const p = yield* o.getThreadProjection(parent);
        const task = p.subagents.find((t) => t.id === taskId)!;
        const node = p.nodes.find((n) => n.id === taskId)!;
        const item = p.turnItems.find((i) => i.type === "subagent" && i.subagentId === taskId);
        trace({
          name,
          stage: "promoted-held",
          task: working,
          storedTask: task,
          storedNode: node,
          storedItem: item,
          child: promotedChild,
        });
        NodeAssert.equal(working.status, "running");
        NodeAssert.equal(working.workState, "working");
        NodeAssert.equal(working.summary, null);
        NodeAssert.equal(task.status, "running");
        NodeAssert.equal(task.result, null);
        NodeAssert.equal(node.status, "running");
        NodeAssert.equal(item?.status, "running");
        NodeAssert.equal(yield* o.delegatedTaskResultPending(child, taskId), true);
        yield* o.recoverDelegatedTasks;
        yield* o.recoverDelegatedTasks;
        NodeAssert.equal((yield* service.taskStatus(scope, taskId)).status, "running");
        const resultText = `JOINED_${name}_RESULT`;
        const beforeFinish = yield* sink.latestSequence();
        const result = yield* finish(child, outcome, resultText);
        yield* o.recoverDelegatedTask(child, active.id);
        yield* sink.stream({ afterSequence: beforeFinish, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === taskId &&
              stored.event.payload.status === outcome,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const settled = yield* o.getThreadProjection(parent);
        const shared = settled.contextTransfers.filter(
          (t) => t.sourcePoint.runId === result.run.id,
        );
        const ids = owner === "delegated" ? [active.delegatedTaskId!, taskId] : [taskId];
        NodeAssert.equal(shared.length, 1);
        for (const id of ids) {
          const value = settled.subagents.find((task) => task.id === id)!;
          NodeAssert.equal(value.status, outcome);
          NodeAssert.equal(value.result, resultText);
          NodeAssert.notEqual(value.completionDelivery?.state, "acknowledged");
          NodeAssert.equal(settled.nodes.find((node) => node.id === id)?.status, outcome);
          NodeAssert.equal(
            settled.turnItems.find((item) => item.type === "subagent" && item.subagentId === id)
              ?.status,
            outcome,
          );
        }
        const acknowledgement = () =>
          o
            .getThreadProjection(parent)
            .pipe(
              Effect.map((p) =>
                ids.map((id) => p.subagents.find((t) => t.id === id)!.completionDelivery?.state),
              ),
            );
        const beforeRead = yield* acknowledgement();
        NodeAssert.ok(beforeRead.every((state) => state !== "acknowledged"));
        const childProjection = yield* o.getThreadProjection(child);
        const nonResult = childProjection.turnItems.find((i) => i.type === "user_message")!;
        for (const input of [
          { itemId: nonResult.id },
          { itemId: result.itemId, maxCharsPerItem: 3 },
          { itemId: result.itemId, textOffset: 1 },
        ]) {
          const page = yield* service.readThread(scope, { threadId: child, limit: 1, ...input });
          NodeAssert.deepEqual(yield* acknowledgement(), beforeRead);
          trace({ name, stage: "negative-page", input, page, delivery: yield* acknowledgement() });
        }
        const page = yield* service.readThread(scope, {
          threadId: child,
          itemId: result.itemId,
          limit: 1,
        });
        NodeAssert.equal(page.items.length, 1);
        NodeAssert.equal(
          page.items[0]!.type,
          outcome === "completed" ? "assistant_message" : "error",
        );
        NodeAssert.deepEqual(
          yield* acknowledgement(),
          ids.map(() => "acknowledged"),
        );
        for (const id of ids) {
          const resolved = yield* service.taskStatus(scope, id);
          NodeAssert.equal(resolved.status, outcome);
          NodeAssert.equal(resolved.summary, resultText);
          NodeAssert.equal(resolved.resultContextTransferId, shared[0]!.id);
          trace({ name, stage: "resolved-task", task: resolved });
        }
        const afterRead = yield* o.getThreadProjection(parent);
        yield* service.readThread(scope, { threadId: child, itemId: result.itemId, limit: 1 });
        yield* o.recoverDelegatedTasks;
        yield* o.recoverDelegatedTasks;
        const again = yield* o.getThreadProjection(parent);
        NodeAssert.deepEqual(again.contextTransfers, settled.contextTransfers);
        NodeAssert.deepEqual(again.subagents, afterRead.subagents);
        NodeAssert.deepEqual(again.runs, afterRead.runs);
        trace({
          name,
          stage: "settled",
          result: yield* service.taskStatus(scope, taskId),
          sharedTransferId: shared[0]!.id,
          resultPage: page,
          acknowledgedTasks: ids,
          parent: again,
        });
        console.log(
          JSON.stringify({
            name,
            status: "passed",
            outcome,
            sharedTransfers: shared.length,
            acknowledgedTasks: ids.length,
          }),
        );
      }).pipe(Effect.provide(Layer.merge(runtime, mcp)));
    }),
  );

try {
  for (const owner of ["delegated", "monitor"] as const)
    for (const outcome of ["completed", "failed"] as const)
      await Effect.runPromise(run(owner, outcome).pipe(Effect.timeout("5 minutes")));
  NodeFS.writeFileSync(
    NodePath.join(output, "verdict.json"),
    JSON.stringify({ status: "passed", revision }),
  );
} catch (error) {
  NodeFS.writeFileSync(
    NodePath.join(output, "verdict.json"),
    JSON.stringify({ status: "failed", revision, error: String(error) }),
  );
  throw error;
}
