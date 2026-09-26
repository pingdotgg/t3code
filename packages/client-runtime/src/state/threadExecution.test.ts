import {
  TurnItemId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  formatModelSelectionEffort,
  formatProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";
import { threadRuntimeCanArchive, type ThreadRuntimeSummary } from "./models.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

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
  it("derives the current root failure without inheriting errors from children or previous runs", () => {
    const failed = { ...run("limited", 1, "failed"), rootNodeId: NodeId.make("root") };
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed], turnItems: [item] };
    expect(deriveThreadRuntime(projection)).toMatchObject({
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, nodeId: NodeId.make("child") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({
        ...projection,
        runs: [{ ...failed, rootNodeId: NodeId.make("new-root") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, run("new", 2, "running")] }),
    ).toMatchObject({ status: "running", lastError: null, lastErrorClass: null });
  });

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
});

describe("deriveRunlessWorkStartedAt", () => {
  const later = DateTime.makeUnsafe("2026-07-28T10:05:00.000Z");
  const rootTurn = (
    status: OrchestrationV2ExecutionNode["status"],
    startedAt = now,
  ): OrchestrationV2ExecutionNode => ({
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn",
    status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt: null,
  });

  const nativeChild = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource: "provider" as const,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
  };

  it("times a provider-native subagent from its runless root turn while it works", () => {
    const projection = { ...nativeChild, nodes: [rootTurn("running", later)] };
    expect(deriveRunlessWorkStartedAt(projection)).toBe("2026-07-28T10:05:00.000Z");
    // The subagent has no run, so it stays unstoppable and unqueueable.
    expect(deriveThreadRuntime(projection)).toBeNull();
  });

  it.each(["completed", "cancelled", "failed", "interrupted", "idle"] as const)(
    "is idle once the subagent is %s",
    (status) => {
      expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [rootTurn(status)] })).toBe(null);
    },
  );

  it("ignores root turns that belong to a run, and threads the provider does not run", () => {
    const owned = { ...rootTurn("running"), runId: RunId.make("run-1") };
    expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [owned] })).toBeNull();
    expect(
      deriveRunlessWorkStartedAt({ ...v2Projection, nodes: [rootTurn("running")] }),
    ).toBeNull();
  });
});

describe("deriveProviderSubagentStatus", () => {
  const root = {
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn" as const,
    status: "completed" as const,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  };
  const child = (creationSource: "provider" | "mcp") => ({
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
    nodes: [root],
  });

  it("reports the provider's own subagent from its runless root turn", () => {
    expect(deriveProviderSubagentStatus(child("provider"))).toEqual({
      status: "completed",
      startedAt: "2026-07-28T10:00:00.000Z",
      completedAt: "2026-07-28T10:00:00.000Z",
    });
  });

  it("says how long the subagent has worked, or took", () => {
    const startedAt = "2026-07-28T10:00:00.000Z";
    const at = (iso: string) => Date.parse(iso);
    expect(
      formatProviderSubagentStatus(
        { status: "running", startedAt, completedAt: null },
        at("2026-07-28T10:01:05.400Z"),
      ),
    ).toBe("Working 1m 5s");
    expect(
      formatProviderSubagentStatus(
        { status: "completed", startedAt, completedAt: "2026-07-28T10:00:34.000Z" },
        at("2026-07-28T11:00:00.000Z"),
      ),
    ).toBe("Completed in 34s");
    expect(
      formatProviderSubagentStatus(
        { status: "cancelled", startedAt, completedAt: "2026-07-28T10:00:34.000Z" },
        0,
      ),
    ).toBe("Cancelled");
    expect(formatProviderSubagentStatus(null, 0)).toBe("Starting");
  });

  it("leaves T3 delegated tasks and ordinary threads alone", () => {
    expect(deriveProviderSubagentStatus(child("mcp"))).toBeNull();
    expect(deriveProviderSubagentStatus({ ...v2Projection, nodes: [root] })).toBeNull();
  });
});

describe("formatModelSelectionEffort", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const selection = (options?: ReadonlyArray<{ id: string; value: string }>) => ({
    instanceId,
    model: "claude-sonnet-5",
    ...(options === undefined ? {} : { options }),
  });
  const catalog = (descriptor: { currentValue?: string }) => [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ],
            ...descriptor,
          },
        ],
      },
    },
  ];

  it("shows the model's default effort when the user never picked one", () => {
    expect(formatModelSelectionEffort(selection(), catalog({}))).toBe("High");
  });

  it("names a stored effort the way the catalog does", () => {
    expect(
      formatModelSelectionEffort(selection([{ id: "effort", value: "xhigh" }]), catalog({})),
    ).toBe("Extra High");
  });

  it("uses the descriptor's current value over the default", () => {
    expect(formatModelSelectionEffort(selection(), catalog({ currentValue: "medium" }))).toBe(
      "Medium",
    );
  });

  it("shows nothing for a model the catalog does not describe", () => {
    expect(formatModelSelectionEffort(selection([{ id: "effort", value: "high" }]))).toBeNull();
    expect(
      formatModelSelectionEffort(
        { ...selection(), model: "claude-haiku-4-5" },
        catalog({ currentValue: "medium" }),
      ),
    ).toBeNull();
  });
});

describe("threadRuntimeCanArchive", () => {
  const runtime = (
    status: ThreadRuntimeSummary["status"],
    activeRunId: ThreadRuntimeSummary["activeRunId"],
  ): ThreadRuntimeSummary => ({
    status,
    activeRunId,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: DateTime.formatIso(now),
  });

  it.each(["preparing", "starting", "running"] as const)(
    "blocks archive while a provider is %s",
    (status) => {
      expect(threadRuntimeCanArchive(runtime(status, RunId.make(`run-${status}`)))).toBe(false);
    },
  );

  it("only blocks a queued runtime when a provider run remains attached", () => {
    expect(threadRuntimeCanArchive(runtime("queued", RunId.make("run-queued")))).toBe(false);
    expect(threadRuntimeCanArchive(runtime("queued", null))).toBe(true);
  });

  it("allows waiting and idle threads", () => {
    expect(threadRuntimeCanArchive(runtime("waiting", RunId.make("run-finished")))).toBe(true);
    expect(threadRuntimeCanArchive(runtime("idle", null))).toBe(true);
  });
});
