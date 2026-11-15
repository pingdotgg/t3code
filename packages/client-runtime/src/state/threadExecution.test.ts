import {
  TurnItemId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderDriverKind,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  canResumeThread,
  deriveReportedModelSelection,
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  deriveProviderExtensionStatuses,
  deriveResumableRunId,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  formatModelSelectionEffort,
  isBackgroundWorkStopPending,
  presentPendingBackgroundWork,
  presentProviderGoal,
  presentRunStop,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

function request(
  id: string,
  status: OrchestrationV2RuntimeRequest["status"],
): OrchestrationV2RuntimeRequest {
  return {
    id: RuntimeRequestId.make(id),
    nodeId: NodeId.make(`node-${id}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status,
    responseCapability: { type: "not_resumable", reason: "Session ended." },
    createdAt: now,
    resolvedAt: status === "pending" ? null : now,
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
  it("shows extension statuses only from the selected provider's current live session", () => {
    const instanceId = v2Projection.thread.modelSelection.instanceId;
    const providerThreadId = ProviderThreadId.make("native-status-thread");
    const sessionId = ProviderSessionId.make("native-status-session");
    const statuses = [{ key: "watch", text: "Watching" }];
    const projection = {
      thread: { ...v2Projection.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        { id: providerThreadId, providerSessionId: sessionId, providerInstanceId: instanceId },
      ],
      providerSessions: [
        {
          id: sessionId,
          providerInstanceId: instanceId,
          status: "ready" as const,
          extensionStatuses: statuses,
        },
      ],
    };
    expect(deriveProviderExtensionStatuses(projection)).toEqual(statuses);
    expect(
      deriveProviderExtensionStatuses({
        ...projection,
        providerSessions: [
          ...projection.providerSessions,
          {
            ...projection.providerSessions[0]!,
            id: ProviderSessionId.make("unrelated"),
            extensionStatuses: [{ key: "wrong", text: "Wrong session" }],
          },
        ],
      }),
    ).toEqual(statuses);
    expect(
      deriveProviderExtensionStatuses({
        ...projection,
        providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" }],
      }),
    ).toEqual([]);
    expect(
      deriveProviderExtensionStatuses({
        ...projection,
        providerSessions: [{ ...projection.providerSessions[0]!, status: "error" }],
      }),
    ).toEqual(statuses);
    expect(
      deriveProviderExtensionStatuses({
        ...projection,
        providerSessions: [
          { ...projection.providerSessions[0]!, status: "error", extensionStatuses: [] },
        ],
      }),
    ).toEqual([]);
    expect(
      deriveProviderExtensionStatuses({
        ...projection,
        providerSessions: [{ ...projection.providerSessions[0]!, extensionStatuses: undefined }],
      }),
    ).toEqual([]);
    expect(
      deriveProviderExtensionStatuses({
        ...projection,
        thread: {
          ...projection.thread,
          modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "default" },
        },
      }),
    ).toEqual([]);
    expect(deriveProviderExtensionStatuses(null)).toEqual([]);
  });

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
    expect(deriveResumableRunId(projection, deriveThreadRuntime(projection))).toBe(failed.id);
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

  // regression: #15029 working timers no longer reset on every background wake
  it("counts a wake run's activity from the start of the work it continues", () => {
    const workStartedAt = DateTime.makeUnsafe("2026-07-28T09:20:00.000Z");
    const wake = { ...run("wake", 2, "running"), workStartedAt };
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "completed"), wake] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T09:20:00.000Z");
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "running")] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T10:00:00.000Z");
  });

  it("keeps a subscription limit visible while later messages stay queued", () => {
    const failed = {
      ...run("limited", 1, "failed"),
      rootNodeId: NodeId.make("root"),
      completedAt: now,
    };
    const queued = run("queued", 2, "queued");
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
    const projection = { ...v2Projection, runs: [failed, queued], turnItems: [item] };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "failed",
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(deriveResumableRunId(projection, deriveThreadRuntime(projection))).toBe(failed.id);
    const cancelledQueued = {
      ...run("cancelled-queued", 3, "cancelled"),
      startedAt: null,
      completedAt: now,
    };
    expect(
      usageLimitBlockedRun([failed, queued, cancelledQueued], projection.turnItems, null)?.id,
    ).toBe(failed.id);
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, queued, cancelledQueued] }),
    ).toMatchObject({ status: "failed", lastErrorClass: "usage_limit" });
    const providerError = {
      ...projection,
      turnItems: [{ ...item, failure: { ...item.failure, class: "provider_error" as const } }],
    };
    expect(deriveThreadRuntime(providerError)).toMatchObject({
      status: "queued",
      lastErrorClass: null,
    });
    expect(deriveResumableRunId(providerError, deriveThreadRuntime(providerError))).toBeNull();
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

  it("marks an open run whose provider turn already ended", () => {
    const attemptId = RunAttemptId.make("attempt-open");
    const openRun = { ...run("run-open", 1, "running"), activeAttemptId: attemptId };
    const providerTurn = (status: "running" | "failed") => ({
      id: ProviderTurnId.make("provider-turn-open"),
      providerThreadId: ProviderThreadId.make("provider-thread-open"),
      nodeId: NodeId.make("node-open"),
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status,
      startedAt: now,
      completedAt: status === "running" ? null : now,
    });
    const projection = (status: "running" | "failed") => ({
      ...v2Projection,
      runs: [openRun],
      providerTurns: [providerTurn(status)],
      updatedAt: now,
    });

    expect(deriveThreadActivityRun(projection("running"))?.turnEnded).toBeUndefined();
    expect(deriveThreadActivityRun(projection("failed"))).toMatchObject({
      status: "running",
      turnEnded: true,
    });
  });

  // The server marks a run running before the provider opens, which can take minutes.
  it("labels an open run whose provider has not started a turn", () => {
    const attemptId = RunAttemptId.make("attempt-starting");
    const openRun = { ...run("run-starting", 1, "running"), activeAttemptId: attemptId };
    const session = {
      id: ProviderSessionId.make("session-starting"),
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: openRun.providerInstanceId,
      status: "starting" as const,
      cwd: "/repo",
      model: null,
      // The label reads only the driver.
      capabilities: {} as never,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const starting = { ...v2Projection, runs: [openRun], providerSessions: [session] };

    expect(deriveThreadActivityRun(starting)?.providerStartingLabel).toBe("Starting Claude");
    expect(
      deriveThreadActivityRun({ ...starting, providerSessions: [] })?.providerStartingLabel,
    ).toBe("Starting");
    expect(
      deriveThreadActivityRun({
        ...starting,
        providerTurns: [
          {
            id: ProviderTurnId.make("provider-turn-starting"),
            providerThreadId: ProviderThreadId.make("provider-thread-starting"),
            nodeId: NodeId.make("node-starting"),
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        ],
      })?.providerStartingLabel,
    ).toBeUndefined();
  });

  it("presents a held queue as the stopped run instead of queued work", () => {
    const interrupted = { ...run("run-interrupted", 1, "interrupted"), completedAt: now };
    const held = { ...run("run-held", 2, "queued"), queueHeld: true };
    const projection = { ...v2Projection, runs: [interrupted, held], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "interrupted",
      activeRunId: null,
    });
    expect(deriveResumableRunId(projection, deriveThreadRuntime(projection))).toBe(interrupted.id);

    const resumed = { ...projection, runs: [interrupted, { ...held, queueHeld: false }] };
    expect(deriveThreadRuntime(resumed)).toMatchObject({ status: "queued" });

    const onlyHeld = {
      ...projection,
      runs: [held],
      thread: { ...projection.thread, activeProviderThreadId: null },
    };
    expect(deriveLatestThreadRun(onlyHeld)).toBeNull();
    expect(deriveThreadRuntime(onlyHeld)).toBeNull();
  });

  it.each([
    { name: "no requests", requests: [], runId: "run-stopped", held: false, expected: true },
    {
      name: "a pending request",
      requests: [request("approval", "pending")],
      runId: "run-stopped",
      held: false,
      expected: false,
    },
    {
      name: "only a resolved request",
      requests: [request("approval", "resolved")],
      runId: "run-stopped",
      held: false,
      expected: true,
    },
    {
      name: "a held queue behind a blocked continuation",
      requests: [request("approval", "pending")],
      runId: "run-stopped",
      held: true,
      expected: false,
    },
    {
      name: "a held queue with no run to continue",
      requests: [request("approval", "pending")],
      runId: null,
      held: true,
      expected: true,
    },
    { name: "nothing to resume", requests: [], runId: null, held: false, expected: false },
  ])("decides whether Resume can start with $name", ({ requests, runId, held, expected }) => {
    expect(
      canResumeThread(
        { runtimeRequests: requests },
        runId === null ? null : RunId.make(runId),
        held,
      ),
    ).toBe(expected);
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
});

describe("presentRunStop", () => {
  const signal = (type: "run_interrupt_request" | "run_interrupt_result", runId: RunId) => ({
    id: TurnItemId.make(`${type}:${runId}`),
    threadId: v2Projection.thread.id,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: type === "run_interrupt_result" ? ("interrupted" as const) : ("completed" as const),
    title: "Interrupt",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type,
    message: "Stopped by user",
  });
  const running = run("run-stopping", 1, "running");
  const request = signal("run_interrupt_request", running.id);

  it.each([
    { name: "no Stop", runs: [running], turnItems: [], state: null },
    {
      name: "a Stop the agent is winding down",
      runs: [running],
      turnItems: [request],
      state: "stopping",
    },
    {
      name: "a Stop the provider never confirmed",
      runs: [running],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
    {
      name: "a Stop that ended the run",
      runs: [running],
      turnItems: [request, signal("run_interrupt_result", running.id)],
      state: null,
    },
    {
      name: "a settled run's background work still stopping",
      runs: [{ ...running, status: "completed" as const, completedAt: now }],
      turnItems: [request],
      state: null,
    },
    {
      name: "a settled run whose background work ignored Stop",
      runs: [{ ...running, status: "completed" as const, completedAt: now }],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
    {
      name: "a settled run whose background work ignored Stop, with a queued follow-up",
      runs: [
        { ...running, status: "completed" as const, completedAt: now },
        run("run-queued", 2, "queued"),
      ],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
  ])("presents $name", ({ runs, turnItems, state }) => {
    expect(presentRunStop({ runs, turnItems })?.state ?? null).toBe(state);
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
    const projection = {
      ...nativeChild,
      thread: {
        ...nativeChild.thread,
        activeProviderThreadId: ProviderThreadId.make("native-child"),
      },
      nodes: [rootTurn("running", later)],
    };
    expect(deriveRunlessWorkStartedAt(projection)).toBe("2026-07-28T10:05:00.000Z");
    expect(deriveThreadRuntime(projection)).toBeNull();
  });

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

  it("leaves T3 delegated tasks and ordinary threads alone", () => {
    expect(deriveProviderSubagentStatus(child("mcp"))).toBeNull();
    expect(deriveProviderSubagentStatus({ ...v2Projection, nodes: [root] })).toBeNull();
  });
});

describe("provider-reported model selection", () => {
  const selected = v2Projection.thread.modelSelection;
  const reported = { ...selected, options: [{ id: "reasoningEffort", value: "default" }] };
  const providerThread = {
    id: ProviderThreadId.make("active"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: selected.instanceId,
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: v2Projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    nativeMetadata: { modelSelection: reported },
  };
  const projection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, activeProviderThreadId: providerThread.id },
    providerThreads: [providerThread],
  };

  it("reads only the active provider thread's reported selection", () => {
    expect(deriveReportedModelSelection(projection)).toBe(reported);
    expect(
      deriveReportedModelSelection({
        ...projection,
        thread: { ...projection.thread, activeProviderThreadId: null },
      }),
    ).toBeNull();
    expect(
      deriveReportedModelSelection({
        ...projection,
        providerThreads: [
          { ...providerThread, providerInstanceId: ProviderInstanceId.make("other") },
        ],
      }),
    ).toBeNull();
  });
});

describe("formatModelSelectionEffort", () => {
  it("labels an old Ultracode effort by the effort it runs at", () => {
    const models = [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "high", label: "High", isDefault: true },
                { id: "xhigh", label: "Extra High" },
              ],
            },
            { id: "ultracode", label: "Ultracode", type: "boolean" },
          ],
        }),
      },
    ];
    const selection = createModelSelection(
      ProviderInstanceId.make("claudeAgent"),
      "claude-opus-5-5",
      [{ id: "effort", value: "ultracode" }],
    );

    expect(formatModelSelectionEffort(selection, models)).toBe("Extra High");
  });
});

describe("isBackgroundWorkStopPending", () => {
  const tasks = [{ taskId: "dev-server" }];
  const sent = { threadKey: "env:thread", taskIds: ["dev-server"], retryAt: null };
  const accepted = { ...sent, retryAt: 10_000 };

  it("stays pending after acceptance while a stopped task is still listed", () => {
    expect(isBackgroundWorkStopPending(sent, "env:thread", tasks, false)).toBe(true);
    expect(isBackgroundWorkStopPending(accepted, "env:thread", tasks, false)).toBe(true);
  });

  it("ends once the stopped tasks leave, even if new work starts", () => {
    expect(isBackgroundWorkStopPending(accepted, "env:thread", [], false)).toBe(false);
    expect(isBackgroundWorkStopPending(accepted, "env:thread", [{ taskId: "next" }], false)).toBe(
      false,
    );
  });

  it("allows retry at the deadline even if a stopped task remains", () => {
    const request = { ...accepted, retryAt: 10_000 };
    expect(isBackgroundWorkStopPending(request, "env:thread", tasks, false)).toBe(true);
    expect(isBackgroundWorkStopPending(request, "env:thread", tasks, true)).toBe(false);
  });

  it("only applies to the thread that sent the Stop", () => {
    expect(isBackgroundWorkStopPending(null, "env:thread", tasks, false)).toBe(false);
    expect(isBackgroundWorkStopPending(sent, "env:other", tasks, false)).toBe(false);
  });
});

describe("presentProviderGoal", () => {
  it("rolls token counts that round to 1000k over to 1m", () => {
    const usage = (tokensUsed: number) =>
      presentProviderGoal(
        { objective: "Ship the feature", status: "active", tokensUsed, tokenBudget: 2_000_000 },
        true,
      ).usage;
    expect(usage(999_499)).toBe("999k / 2m tokens");
    expect(usage(999_500)).toBe("1m / 2m tokens");
    expect(usage(999_999)).toBe("1m / 2m tokens");
    expect(usage(1_000_000)).toBe("1m / 2m tokens");
    expect(
      presentProviderGoal(
        {
          objective: "Ship the feature",
          status: "paused",
          tokensUsed: 999_500,
          tokenBudget: 999_500,
        },
        false,
      ).usage,
    ).toBe("1m / 1m tokens");
  });
});

describe("presentPendingBackgroundWork", () => {
  it("names a command by its script, not the shell that wraps it", () => {
    const presentation = presentPendingBackgroundWork([
      {
        taskId: "call_1",
        kind: "command",
        description: `/bin/zsh -lc "mv a.ts b.ts\ncat > b.ts <<'EOF'\nexport {};\nEOF"`,
      },
    ]);
    expect(presentation?.items[0]?.label).toBe("mv a.ts b.ts\ncat > b.ts <<'EOF'\nexport {};\nEOF");
  });
});
