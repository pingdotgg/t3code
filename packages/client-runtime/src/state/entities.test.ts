import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  InvalidScopedProjectRefCollectionKeyError,
  InvalidScopedThreadKeyError,
  parseProjectRefCollectionKey,
  parseThreadKey,
} from "./entities.ts";
import {
  presentThreadShell,
  resolveThreadProviderStack,
  resolveThreadWorkingStartedAt,
} from "./models.ts";
import { v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveLatestThreadRun, deriveThreadRuntime } from "./threadExecution.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";

const environmentId = EnvironmentId.make("environment-v2");

describe("scoped entity keys", () => {
  it("preserves an invalid thread key as structured error data", () => {
    const key = "missing-thread-key-separator";
    let error: unknown;

    try {
      parseThreadKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toEqual(new InvalidScopedThreadKeyError({ key }));
  });

  it("preserves malformed project reference collection input and its cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseProjectRefCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidScopedProjectRefCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.anything() });
  });

  it("rejects invalid project reference collection shapes", () => {
    const key = JSON.stringify([["environment-1"]]);

    expect(() => parseProjectRefCollectionKey(key)).toThrowError(
      InvalidScopedProjectRefCollectionKeyError,
    );
  });
});

describe("V2 client presentation", () => {
  it("presents shell timestamps and status without constructing V1 state", () => {
    const shell = presentThreadShell(environmentId, v2ThreadShell);
    expect(shell.environmentId).toBe(environmentId);
    expect(shell.createdAt).toBe("2026-06-20T00:00:00.000Z");
    expect(shell.runtime).toBeNull();
    expect(shell.source).toBe(v2ThreadShell);
  });

  it("preserves active ordering and both pull-request sources", () => {
    const linkedPullRequest = {
      projectId: v2ThreadShell.projectId,
      repository: "pingdotgg/t3code",
      number: 42,
      url: "https://github.com/pingdotgg/t3code/pull/42",
    };
    const branchPullRequest = { ...linkedPullRequest, number: 43 };
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      activeOrderKey: "m",
      linkedPullRequest,
      branchPullRequest,
    });

    expect(shell.activeOrderKey).toBe("m");
    expect(shell.linkedPullRequest).toEqual(linkedPullRequest);
    expect(shell.branchPullRequest).toEqual(branchPullRequest);
  });

  it("presents provider errors carried by failed thread shells", () => {
    const runId = RunId.make("run-failed");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: runId,
      status: "failed",
      lastError: "provider process exited",
    });

    expect(shell.runtime).toMatchObject({
      status: "failed",
      lastError: "provider process exited",
    });
  });

  it("lets only blocking questions mark a running thread as awaiting input", () => {
    const runId = RunId.make("run-async-question");
    const running = {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      status: "running" as const,
    };
    const question = {
      id: RuntimeRequestId.make("request-async-question"),
      kind: "user_input" as const,
      createdAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
    };

    const presentInput = (shell: typeof v2ThreadShell) =>
      presentThreadShell(environmentId, shell).hasPendingUserInput;

    expect(
      presentInput({ ...running, pendingRuntimeRequest: { ...question, blocking: false } }),
    ).toBe(false);
    expect(
      presentInput({ ...running, pendingRuntimeRequest: { ...question, blocking: true } }),
    ).toBe(true);
    expect(presentInput({ ...running, pendingRuntimeRequest: question })).toBe(true);
    expect(
      presentInput({
        ...running,
        activeRunId: null,
        status: "completed",
        pendingRuntimeRequest: { ...question, blocking: false },
      }),
    ).toBe(true);
  });

  it("preserves shell run timestamps for sidebar activity clocks", () => {
    const runId = RunId.make("run-working-clock");
    const requestedAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const startedAt = DateTime.makeUnsafe("2026-06-20T01:00:02.000Z");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: runId,
      latestRunRequestedAt: requestedAt,
      latestRunStartedAt: startedAt,
      latestRunCompletedAt: null,
      activeRunId: runId,
      status: "running",
      updatedAt: DateTime.makeUnsafe("2026-06-20T01:04:45.000Z"),
    });

    expect(shell.latestRun).toMatchObject({
      runId,
      status: "running",
      requestedAt: "2026-06-20T01:00:00.000Z",
      startedAt: "2026-06-20T01:00:02.000Z",
      completedAt: null,
    });
  });

  it("parks presented runtime at idle when a settled shell has pending background tasks", () => {
    const runId = RunId.make("run-completed");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: null,
      status: "completed",
      pendingBackgroundTasks: [{ taskId: "bg-1", description: "Watch build", kind: "monitor" }],
    });

    expect(shell.latestRun).toMatchObject({ runId, status: "completed" });
    expect(shell.runtime).toMatchObject({
      status: "idle",
      activeRunId: null,
    });
    expect(shell.pendingBackgroundTasks).toEqual([
      { taskId: "bg-1", description: "Watch build", kind: "monitor" },
    ]);
  });

  it.each([
    { kinds: ["command"], expected: "completed" },
    { kinds: ["command", "subagent"], expected: "idle" },
    { kinds: ["background_task"], expected: "idle" },
  ] as const)("presents a completed shell with $kinds as $expected", ({ kinds, expected }) => {
    const pendingBackgroundTasks = kinds.map((kind, index) => ({
      taskId: `bg-${index}`,
      kind,
    }));
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: RunId.make("run-completed"),
      activeRunId: null,
      status: "completed",
      pendingBackgroundTasks,
    });

    expect(shell.latestRun?.status).toBe("completed");
    expect(shell.runtime).toMatchObject({ status: expected, activeRunId: null });
    expect(shell.pendingBackgroundTasks).toEqual(pendingBackgroundTasks);
  });

  it.each(["running", "waiting"] as const)(
    "preserves shell %s while only commands remain in the roster",
    (status) => {
      const runId = RunId.make("run-command");
      const shell = presentThreadShell(environmentId, {
        ...v2ThreadShell,
        latestRunId: runId,
        activeRunId: runId,
        status,
        pendingBackgroundTasks: [{ taskId: "dev-server", kind: "command" }],
      });

      expect(shell.latestRun?.status).toBe(status);
      expect(shell.runtime).toMatchObject({ status, activeRunId: runId });
      expect(shell.pendingBackgroundTasks).toEqual([{ taskId: "dev-server", kind: "command" }]);
    },
  );

  it("keeps a failed latest run failed while background tasks are still pending", () => {
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: RunId.make("run-failed"),
      activeRunId: null,
      status: "failed",
      lastError: "Provider turn failed",
      pendingBackgroundTasks: [{ taskId: "bg-1", description: "Watch build", kind: "monitor" }],
    });

    // Sidebar and mobile list read runtime "idle" as Waiting before failure.
    expect(shell.runtime).toMatchObject({ status: "failed", lastError: "Provider turn failed" });
    expect(shell.pendingBackgroundTasks).toHaveLength(1);
  });

  it("stacks earlier provider owners behind the current one, newest history first to go", () => {
    const codex = ProviderInstanceId.make("codex");
    const claude = ProviderInstanceId.make("claude");
    const cursor = ProviderInstanceId.make("cursor");
    const grok = ProviderInstanceId.make("grok");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      providerInstanceId: grok,
      modelSelection: { instanceId: grok, model: "grok-4" },
      providerInstanceHistory: [codex, claude, cursor, grok],
    });

    // Three slots: the two most recent earlier owners, then the current one.
    expect(resolveThreadProviderStack(shell)).toEqual([claude, cursor, grok]);
    expect(
      resolveThreadProviderStack({ ...shell, providerInstanceHistory: [codex, grok] }),
    ).toEqual([codex, grok]);
    expect(resolveThreadProviderStack({ ...shell, providerInstanceHistory: [] })).toEqual([grok]);
    // Servers that predate the field decode to an empty history.
    expect(
      presentThreadShell(environmentId, { ...v2ThreadShell, providerInstanceHistory: undefined })
        .providerInstanceHistory,
    ).toEqual([]);
  });

  it("keeps terminal runtime completed when there are no pending background tasks", () => {
    const runId = RunId.make("run-completed");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: null,
      status: "completed",
      pendingBackgroundTasks: [],
    });

    expect(shell.latestRun).toMatchObject({ runId, status: "completed" });
    expect(shell.runtime).toMatchObject({
      status: "completed",
      activeRunId: null,
    });
  });

  it("keeps runtime running when there is no background roster", () => {
    const runId = RunId.make("run-running");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      pendingBackgroundTasks: [],
    });

    expect(shell.latestRun).toMatchObject({ runId, status: "running" });
    expect(shell.runtime).toMatchObject({
      status: "running",
      activeRunId: runId,
    });
  });

  it("keeps an older active run visible over a newer cancelled run", () => {
    const activeRunId = RunId.make("run-active");
    const cancelledRunId = RunId.make("run-cancelled");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: cancelledRunId,
      latestRunStartedAt: null,
      latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T01:05:00.000Z"),
      activeRunId,
      activityRunStatus: "running",
      status: "cancelled",
      pendingBackgroundTasks: [],
    });

    expect(shell.latestRun).toMatchObject({ runId: cancelledRunId, status: "cancelled" });
    expect(shell.runtime).toMatchObject({
      status: "running",
      activeRunId,
    });
  });

  it("keeps an older waiting run visible over a newer cancelled run", () => {
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: RunId.make("run-cancelled"),
      activeRunId: null,
      activityRunStatus: "waiting",
      status: "cancelled",
      pendingBackgroundTasks: [],
    });

    expect(shell.runtime).toMatchObject({ status: "waiting", activeRunId: null });
  });

  it("keeps a post-settlement background roster ahead of activity status", () => {
    const activeRunId = RunId.make("run-active");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: RunId.make("run-cancelled"),
      activeRunId,
      activityRunStatus: "running",
      status: "cancelled",
      pendingBackgroundTasks: [
        { taskId: "bg-activity", description: "background work", kind: "background_task" },
      ],
    });

    expect(shell.runtime).toMatchObject({ status: "idle", activeRunId });
  });

  it("parks runtime idle over stale shell running when the roster is nonempty", () => {
    const runId = RunId.make("run-stale-running");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      // Stale: server already projected a post-settlement roster, but shell
      // status still says running (packaged orchestrator-v2 bug).
      status: "running",
      pendingBackgroundTasks: [{ taskId: "bg-1", description: "Watch build", kind: "monitor" }],
    });

    expect(shell.latestRun).toMatchObject({ runId, status: "running" });
    expect(shell.runtime).toMatchObject({
      status: "idle",
      activeRunId: runId,
    });
    expect(shell.pendingBackgroundTasks).toEqual([
      { taskId: "bg-1", description: "Watch build", kind: "monitor" },
    ]);
  });

  it("parks runtime idle over stale checkpoint waiting when the roster is nonempty", () => {
    const runId = RunId.make("run-stale-waiting");
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      // Stale: checkpoint-oriented waiting masks post-settlement background work.
      status: "waiting",
      pendingBackgroundTasks: [{ taskId: "bg-2", description: "Watch build", kind: "monitor" }],
    });

    expect(shell.latestRun).toMatchObject({ runId, status: "waiting" });
    expect(shell.runtime).toMatchObject({
      status: "idle",
      activeRunId: runId,
    });
    expect(shell.pendingBackgroundTasks).toEqual([
      { taskId: "bg-2", description: "Watch build", kind: "monitor" },
    ]);
  });

  it("derives execution summaries without wrapping or copying the projection", () => {
    const runId = RunId.make("run-1");
    const now = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const projection = {
      ...v2Projection,
      runs: [
        {
          id: runId,
          threadId: v2Projection.thread.id,
          ordinal: 1,
          providerInstanceId: v2Projection.thread.providerInstanceId,
          modelSelection: v2Projection.thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message-user"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      messages: [
        {
          id: MessageId.make("message-user"),
          threadId: v2Projection.thread.id,
          runId,
          nodeId: null,
          role: "user" as const,
          text: "Hello",
          attachments: [],
          streaming: false,
          createdBy: "user" as const,
          creationSource: "web" as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    };

    expect(deriveLatestThreadRun(projection)).toMatchObject({
      runId,
      status: "running",
      requestedAt: "2026-06-20T01:00:00.000Z",
      assistantMessageId: null,
    });
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "running",
      activeRunId: runId,
      providerInstanceId: projection.thread.providerInstanceId,
    });
    for (const status of ["queued", "cancelled"] as const) {
      const later = DateTime.add(now, { hours: 1 });
      const latest = {
        ...projection.runs[0]!,
        id: RunId.make("newer-run"),
        ordinal: 2,
        status,
        requestedAt: later,
        startedAt: null,
        completedAt: status === "cancelled" ? later : null,
      };
      const detail = { ...projection, runs: [...projection.runs, latest], updatedAt: later };
      const shell = presentThreadShell(environmentId, {
        ...v2ThreadShell,
        latestRunId: latest.id,
        latestRunStartedAt: null,
        latestRunRequestedAt: later,
        latestRunCompletedAt: latest.completedAt,
        status,
        activeRunId: runId,
        activityRunStatus: "running",
        activityRunStartedAt: now,
        updatedAt: later,
      });
      expect(resolveThreadWorkingStartedAt(shell)).toBe(DateTime.formatIso(now));
      expect(
        resolveThreadWorkingStartedAt({
          latestRun: deriveLatestThreadRun(detail),
          runtime: deriveThreadRuntime(detail),
        }),
      ).toBe(resolveThreadWorkingStartedAt(shell));
      const stopped = {
        ...detail,
        runs: detail.runs.map((run) => ({
          ...run,
          status: "completed" as const,
          completedAt: later,
        })),
      };
      expect(
        resolveThreadWorkingStartedAt({
          latestRun: deriveLatestThreadRun(stopped),
          runtime: deriveThreadRuntime(stopped),
        }),
      ).toBeNull();
    }
  });

  it("parks waiting runtime for a post-settlement roster without hiding active running work", () => {
    const runId = RunId.make("run-background-presentation");
    const now = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const run = {
      id: runId,
      threadId: v2Projection.thread.id,
      ordinal: 1,
      providerInstanceId: v2Projection.thread.providerInstanceId,
      modelSelection: v2Projection.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message-background-presentation"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "waiting" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const backgroundItem = {
      id: TurnItemId.make("item-background-subagent"),
      threadId: v2Projection.thread.id,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running" as const,
      title: "Background review",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "subagent" as const,
      subagentId: NodeId.make("subagent-review"),
      origin: "provider_native" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      childThreadId: null,
      prompt: "Review the changes",
      result: null,
    };

    expect(
      deriveThreadRuntime({
        ...v2Projection,
        runs: [run],
        turnItems: [backgroundItem],
      }),
    ).toMatchObject({
      status: "idle",
      activeRunId: null,
    });
    expect(
      deriveThreadRuntime({
        ...v2Projection,
        runs: [{ ...run, status: "running" as const }],
        turnItems: [backgroundItem],
      }),
    ).toMatchObject({
      status: "running",
      activeRunId: runId,
    });
    expect(
      deriveThreadRuntime({
        ...v2Projection,
        runs: [{ ...run, status: "failed" as const, completedAt: now }],
        turnItems: [backgroundItem],
      }),
    ).toMatchObject({ status: "failed", activeRunId: null });
    const commandItem = {
      ...backgroundItem,
      id: TurnItemId.make("item-background-command"),
      type: "command_execution" as const,
      input: "npm run dev",
    };
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run], turnItems: [commandItem] }),
    ).toMatchObject({ status: "waiting", activeRunId: null });

    for (const [turnItems, status] of [
      [[commandItem], "completed"],
      [[backgroundItem], "idle"],
      [[commandItem, backgroundItem], "idle"],
    ] as const) {
      expect(
        deriveThreadRuntime({
          ...v2Projection,
          runs: [{ ...run, status: "completed", completedAt: now }],
          turnItems,
        }),
      ).toMatchObject({ status, activeRunId: null });
    }

    for (const kind of ["monitor", "background_task"] as const) {
      const providerThread = {
        id: ProviderThreadId.make("provider-thread-background"),
        driver: ProviderDriverKind.make("claudeCode"),
        providerInstanceId: v2Projection.thread.providerInstanceId,
        providerSessionId: null,
        appThreadId: v2Projection.thread.id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "background-task", kind }],
        createdAt: now,
        updatedAt: now,
      };
      for (const status of ["completed", "failed"] as const) {
        expect(
          deriveThreadRuntime({
            ...v2Projection,
            runs: [{ ...run, status, completedAt: now }],
            providerThreads: [providerThread],
          }),
        ).toMatchObject({ status: status === "failed" ? "failed" : "idle", activeRunId: null });
      }
    }
  });

  it("joins pending request entities to their native turn-item display data", () => {
    const now = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const requestId = RuntimeRequestId.make("request-approval");
    const item = {
      id: TurnItemId.make("item-approval"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId: NodeId.make("node-root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "approval_request" as const,
      requestId,
      requestKind: "command" as const,
      prompt: "Allow command?",
    };
    const projection = {
      ...v2Projection,
      runtimeRequests: [
        {
          id: requestId,
          nodeId: NodeId.make("node-root"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command" as const,
          status: "pending" as const,
          responseCapability: {
            type: "not_resumable" as const,
            reason: "provider disconnected",
          },
          createdAt: now,
          resolvedAt: null,
        },
      ],
      turnItems: [item],
      updatedAt: now,
    };

    expect(derivePendingThreadRequests(projection).approvals).toEqual([
      {
        requestId,
        requestKind: "command",
        createdAt: "2026-06-20T01:00:00.000Z",
        detail: "Allow command?",
        responseCapability: "not_resumable",
      },
    ]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([]);
  });

  it("preserves structured-question selection mode and defaults legacy payloads", () => {
    const now = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const multiRequestId = RuntimeRequestId.make("request-multi-select");
    const legacyRequestId = RuntimeRequestId.make("request-legacy-single-select");
    const runtimeRequests = [multiRequestId, legacyRequestId].map((id) => ({
      id,
      nodeId: NodeId.make(`node-${id}`),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: ProviderSessionId.make("provider-session-questions"),
      },
      createdAt: now,
      resolvedAt: null,
    }));
    const common = {
      threadId: v2Projection.thread.id,
      runId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "user_input_request" as const,
    };
    const projection = {
      ...v2Projection,
      runtimeRequests,
      turnItems: [
        {
          ...common,
          id: TurnItemId.make("item-multi-select"),
          nodeId: NodeId.make("node-request-multi-select"),
          requestId: multiRequestId,
          questions: [
            {
              id: "regions",
              header: "Regions",
              question: "Which regions?",
              options: [
                { label: "US", description: "United States" },
                { label: "EU", description: "European Union" },
              ],
              multiSelect: true,
            },
          ],
        },
        {
          ...common,
          id: TurnItemId.make("item-legacy-single-select"),
          nodeId: NodeId.make("node-request-legacy-single-select"),
          requestId: legacyRequestId,
          questions: [
            {
              id: "target",
              header: "Target",
              question: "Which target?",
              options: [{ label: "Staging", description: "Staging environment" }],
            },
          ],
        },
      ],
      updatedAt: now,
    };

    expect(
      derivePendingThreadRequests(projection).userInputs.map((input) => ({
        requestId: input.requestId,
        multiSelect: input.questions[0]?.multiSelect,
      })),
    ).toEqual([
      { requestId: multiRequestId, multiSelect: true },
      { requestId: legacyRequestId, multiSelect: false },
    ]);
  });
});
