import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:queued-task-parent");
const childThreadId = ThreadId.make("thread:queued-task-child");
const taskId = NodeId.make("node:queued-task");
const now = DateTime.makeUnsafe("2026-10-03T11:00:00Z");
const providerInstanceId = ProviderInstanceId.make("claude_two");
const scope: McpInvocationScope = {
  requestNamespace: "test",
  client: undefined,
  environmentId: EnvironmentId.make("environment:queued-task"),
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:queued-task",
    providerInstanceId,
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function fixture(
  options: {
    published?: boolean;
    executing?: boolean;
    failCancellation?: boolean;
    secondQueued?: boolean;
    deliveryPending?: boolean;
  } = {},
) {
  const projectId = ProjectId.make("project:queued-task");
  const thread = {
    id: childThreadId,
    projectId,
    title: "Child",
    modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
    lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId: parentThreadId },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    runtimeMode: "full-access",
    interactionMode: "default",
  };
  const run = (ordinal: number, status: string) => ({
    id: RunId.make(`run:queued-task:${ordinal}`),
    threadId: childThreadId,
    ordinal,
    status,
    userMessageId: MessageId.make(`message:queued-task:${ordinal}`),
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: status === "failed" || status === "completed" ? now : null,
    queueHeld: status === "queued",
    modelSelection: thread.modelSelection,
    providerInstanceId,
  });
  const child = {
    thread,
    runs: [
      run(1, "failed"),
      run(2, "queued"),
      run(3, "completed"),
      run(4, "completed"),
      ...(options.executing ? [run(5, "running")] : []),
      ...(options.secondQueued ? [run(6, "queued")] : []),
    ],
    messages: [
      {
        id: MessageId.make("result:queued-task:4"),
        runId: RunId.make("run:queued-task:4"),
        role: "assistant",
        text: "Latest completed follow-up result",
        updatedAt: now,
      },
    ],
    turnItems: [],
    providerThreads: [{ status: "idle", pendingBackgroundTasks: [] }],
    runtimeRequests: [],
    contextTransfers: [],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const parent = {
    thread: {
      ...thread,
      id: parentThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null },
    },
    runs: [],
    contextTransfers: [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        childThreadId,
        origin: "app_owned",
        status: options.published ? "completed" : "running",
        providerInstanceId,
        model: "claude-opus-5-5",
        result: options.published ? "Published original result" : null,
        completionDelivery: { state: options.deliveryPending ? "pending" : "disposed" },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const commands: OrchestrationV2ServerCommand[] = [];
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(child.thread as never),
          getThreadRecords: (id) => Effect.succeed(id === parentThreadId ? parent : child),
          getProjectThreadRecords: () => Effect.succeed(child),
          stopDelegatedTasks: () => Effect.void,
          delegatedTaskResultPending: () => Effect.succeed(true),
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          dispatch: (command) =>
            Effect.suspend(() => {
              commands.push(command);
              return options.failCancellation && command.type === "thread.stop"
                ? Effect.fail(new Error("Cancellation failed") as never)
                : Effect.succeed({} as never);
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ProjectService.ProjectService)({}),
      ),
    ),
  );
  return { child, parent, commands, layer };
}

it.effect("reports an old held continuation as queued and keeps the latest result readable", () => {
  const { commands, layer } = fixture();
  return Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const task = yield* service.taskStatus(scope, taskId);
    assert.equal(task.status, "queued");
    assert.equal(task.workState, "working");
    // Held input remains visible in the queue counts, but does not count as active child work.
    assert.equal(task.hasPendingChildRuns, false);
    assert.equal(task.latestTerminalRunId, RunId.make("run:queued-task:4"));
    assert.equal(task.latestTerminalSummary, "Latest completed follow-up result");
    assert.isNull(task.summary);
    const read = yield* service.readThread(scope, { threadId: childThreadId, runLimit: 1 });
    assert.equal(read.thread.status, "completed");
    assert.isNull(read.thread.activeRunId);
    assert.equal(read.thread.pendingRequestCount, 0);
    assert.equal(read.thread.queuedRunCount, 1);
    assert.equal(read.thread.heldQueuedRunCount, 1);
    assert.equal(read.recentRuns.length, 1);
    assert.deepEqual(commands, []);
  }).pipe(Effect.provide(layer));
});

it.effect("stops queued-only unpublished work while preserving held input", () => {
  const { commands, child, layer } = fixture({ secondQueued: true });
  return Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.cancelTask(scope, { taskId, clientRequestId: "cancel-held" });
    assert.equal(result.status, "cancel_requested");
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.stop"],
    );
    const command = commands[0]!;
    if (command.type !== "thread.stop") return yield* Effect.die("Expected thread stop");
    assert.equal(command.threadId, childThreadId);
    assert.deepEqual(
      child.runs.filter((run) => run.status === "queued").map((run) => run.queueHeld),
      [true, true],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("keeps truly executing child work running ahead of held queued work", () => {
  const { layer } = fixture({ executing: true });
  return Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.taskStatus(scope, taskId);
    assert.equal(result.status, "running");
    assert.equal(result.hasPendingChildRuns, true);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a published result terminal while stopping later backing-thread work", () => {
  const { commands, layer } = fixture({ published: true, executing: true });
  return Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const status = yield* service.taskStatus(scope, taskId);
    assert.equal(status.status, "completed");
    assert.equal(status.summary, "Published original result");
    assert.equal(status.hasPendingChildRuns, true);
    const cancel = yield* service.cancelTask(scope, {
      taskId,
      clientRequestId: "cancel-published",
    });
    assert.equal(cancel.status, "completed");
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.stop"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("does not dispose completion delivery when stopping the child fails", () => {
  const { commands, layer } = fixture({ failCancellation: true, deliveryPending: true });
  return Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const error = yield* service
      .cancelTask(scope, { taskId, clientRequestId: "cancel-fails" })
      .pipe(Effect.flip);
    assert.equal(error.code, "task_not_cancellable");
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.stop"],
    );
  }).pipe(Effect.provide(layer));
});
