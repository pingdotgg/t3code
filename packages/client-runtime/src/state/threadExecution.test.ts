import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  deriveLatestThreadRun,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  projectionHasInterruptibleProviderNativeBackgroundWork,
  threadRuntimeHasInterruptibleProviderNativeBackgroundWork,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");
const providerDriver = ProviderDriverKind.make("opencode2");

function providerNativeSubagent(
  id: string,
  status: "running" | "completed" | "interrupted" = "running",
) {
  const nodeId = NodeId.make(`node:${id}`);
  return {
    id: nodeId,
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: nodeId,
    origin: "provider_native" as const,
    createdBy: "agent" as const,
    driver: providerDriver,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    providerThreadId: ProviderThreadId.make(`provider-thread:${id}`),
    childThreadId: ThreadId.make(`thread:${id}`),
    nativeTaskRef: { driver: providerDriver, nativeId: id, strength: "strong" as const },
    prompt: "background task",
    title: null,
    model: null,
    status,
    result: null,
    startedAt: now,
    completedAt: status === "running" ? null : now,
    updatedAt: now,
  };
}

function providerChildProjection(input: {
  readonly ownProviderThreadId: ProviderThreadId;
  readonly ownTurnStatus: "running" | "completed";
  readonly includeOwnTurn?: boolean;
  readonly additionalProviderTurns?: OrchestrationV2ThreadProjection["providerTurns"];
  readonly additionalSubagents?: OrchestrationV2ThreadProjection["subagents"];
}) {
  const childThreadId = ThreadId.make("thread:provider-child");
  const providerTurn: OrchestrationV2ThreadProjection["providerTurns"][number] = {
    id: ProviderTurnId.make("provider-turn:provider-child"),
    providerThreadId: input.ownProviderThreadId,
    nodeId: NodeId.make("node:provider-child"),
    runAttemptId: null,
    nativeTurnRef: { driver: providerDriver, nativeId: "turn", strength: "weak" },
    ordinal: 1,
    status: input.ownTurnStatus,
    startedAt: now,
    completedAt: input.ownTurnStatus === "running" ? null : now,
  };
  return {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      id: childThreadId,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
      activeProviderThreadId: input.ownProviderThreadId,
      lineage: {
        parentThreadId: v2Projection.thread.id,
        relationshipToParent: "subagent" as const,
        rootThreadId: v2Projection.thread.id,
      },
    },
    providerTurns: [
      ...(input.includeOwnTurn === false ? [] : [providerTurn]),
      ...(input.additionalProviderTurns ?? []),
    ],
    subagents: input.additionalSubagents ?? [],
  };
}

function run(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

describe("thread execution presentation", () => {
  it("keeps live activity attached to an executing run when a newer run is queued", () => {
    const runningRun = run("run-running", 1, "running");
    const queuedRun = run("run-queued", 2, "queued");
    const projection = { ...v2Projection, runs: [queuedRun, runningRun], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(queuedRun.id);
    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: runningRun.id,
      status: "running",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("does not expose a queued-only run as interruptible", () => {
    const queuedRun = run("run-queued", 1, "queued");
    const projection = { ...v2Projection, runs: [queuedRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: queuedRun.id,
      status: "queued",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "queued",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("keeps a queued summary interruptible when it names an older active run", () => {
    const runtime = {
      status: "queued" as const,
      activeRunId: RunId.make("run-executing-before-queue"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("keeps checkpoint-wait activity visible without exposing a non-functional interrupt", () => {
    const waitingRun = run("run-waiting", 1, "waiting");
    const projection = { ...v2Projection, runs: [waitingRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: waitingRun.id,
      status: "waiting",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "waiting",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("does not expose a stale active run after the runtime parks at idle", () => {
    const runtime = {
      status: "idle" as const,
      activeRunId: RunId.make("run-stale"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("keeps a waiting runtime non-interruptible even when it retains an active run id", () => {
    const runtime = {
      status: "waiting" as const,
      activeRunId: RunId.make("run-waiting"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it.each(["preparing", "starting"] as const)("keeps an active %s run interruptible", (status) => {
    const runtime = {
      status,
      activeRunId: RunId.make(`run-${status}`),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("exposes direct running provider-native children while excluding terminal and app-owned work", () => {
    const directChild = providerNativeSubagent("direct-child");
    const secondDirectChild = providerNativeSubagent("second-direct-child");
    const terminalChild = providerNativeSubagent("terminal-child", "completed");
    const appOwnedChild = {
      ...providerNativeSubagent("app-owned-child"),
      origin: "app_owned" as const,
    };
    const foreignChild = {
      ...providerNativeSubagent("foreign-child"),
      threadId: ThreadId.make("thread:foreign-parent"),
    };
    const projection = {
      ...v2Projection,
      subagents: [directChild, secondDirectChild, terminalChild, appOwnedChild, foreignChild],
    };

    expect(projectionHasInterruptibleProviderNativeBackgroundWork(projection)).toBe(true);
    expect(
      projectionHasInterruptibleProviderNativeBackgroundWork({
        ...projection,
        subagents: [terminalChild, appOwnedChild, foreignChild],
      }),
    ).toBe(false);
    expect(
      threadRuntimeHasInterruptibleProviderNativeBackgroundWork(
        deriveThreadRuntime({ ...projection, runs: [run("run-parent", 1, "completed")] }),
      ),
    ).toBe(true);
  });

  it("exposes the child turn or its directly-owned nested provider work", () => {
    const ownProviderThreadId = ProviderThreadId.make("provider-thread:provider-child");
    const nestedProviderThreadId = ProviderThreadId.make("provider-thread:nested-child");
    const nestedTurn = {
      id: ProviderTurnId.make("provider-turn:nested-child"),
      providerThreadId: nestedProviderThreadId,
      nodeId: NodeId.make("node:nested-child"),
      runAttemptId: null,
      nativeTurnRef: { driver: providerDriver, nativeId: "nested-turn", strength: "weak" as const },
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
    };
    const nestedSubagent = {
      ...providerNativeSubagent("nested-child"),
      threadId: ThreadId.make("thread:provider-child"),
      providerThreadId: nestedProviderThreadId,
      childThreadId: ThreadId.make("thread:nested-child"),
    };
    const child = providerChildProjection({
      ownProviderThreadId,
      ownTurnStatus: "running",
      includeOwnTurn: false,
      additionalProviderTurns: [nestedTurn],
      additionalSubagents: [nestedSubagent],
    });
    expect(projectionHasInterruptibleProviderNativeBackgroundWork(child)).toBe(true);
    expect(
      projectionHasInterruptibleProviderNativeBackgroundWork(
        providerChildProjection({
          ownProviderThreadId,
          ownTurnStatus: "running",
          additionalProviderTurns: [nestedTurn],
          additionalSubagents: [nestedSubagent],
        }),
      ),
    ).toBe(true);
    expect(
      projectionHasInterruptibleProviderNativeBackgroundWork(
        providerChildProjection({ ownProviderThreadId, ownTurnStatus: "completed" }),
      ),
    ).toBe(false);
  });
});
