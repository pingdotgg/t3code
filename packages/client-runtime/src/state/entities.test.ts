import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell, resolveThreadWorkingStartedAt } from "./models.ts";
import { v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveLatestThreadRun, deriveThreadRuntime } from "./threadExecution.ts";
import { isThreadWorking } from "./threadInbox.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";
import { canSnooze, effectiveSnoozed } from "./threadSettled.ts";

const environmentId = EnvironmentId.make("environment-v2");

describe("V2 client presentation", () => {
  it("an async question blocks snooze and wakes a snoozed thread", () => {
    const runId = RunId.make("run-async-question");
    const running = {
      ...v2ThreadShell,
      snoozedAt: DateTime.makeUnsafe("2026-06-19T23:59:00.000Z"),
      snoozedUntil: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
      latestRunId: runId,
      activeRunId: runId,
      status: "running" as const,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-async-question"),
        kind: "user_input" as const,
        createdAt: v2ThreadShell.updatedAt,
        blocking: false,
      },
    };
    const active = presentThreadShell(environmentId, running);
    expect(canSnooze(active, { now: "2026-06-20T00:05:00.000Z" })).toBe(false);
    expect(effectiveSnoozed(active, { now: "2026-06-20T00:05:00.000Z" })).toBe(false);
  });

  it("moves a running thread with any question out of Working", () => {
    for (const capability of [{ blocking: false }, { blocking: true }, {}]) {
      const shell = presentThreadShell(environmentId, {
        ...v2ThreadShell,
        latestRunId: RunId.make("run-blocking-question"),
        activeRunId: RunId.make("run-blocking-question"),
        status: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-blocking-question"),
          kind: "user_input",
          createdAt: v2ThreadShell.updatedAt,
          ...capability,
        },
      });
      expect(shell.hasPendingUserInput).toBe(true);
      expect(isThreadWorking(shell)).toBe(false);
    }
  });

  it("parks a thread that never ran at idle while a pull request watch holds it", () => {
    const watch = {
      taskId: "pull-request-watch:github.com/acme/app#1",
      kind: "monitor" as const,
      awaited: true as const,
    };
    const watched = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: null,
      activeProviderThreadId: null,
      activeRunId: null,
      status: "idle",
      pendingBackgroundTasks: [watch],
    });
    expect(watched.runtime).toMatchObject({ status: "idle", activeRunId: null });
    expect(
      presentThreadShell(environmentId, {
        ...v2ThreadShell,
        latestRunId: null,
        activeProviderThreadId: null,
        status: "idle",
        pendingBackgroundTasks: [],
      }).runtime,
    ).toBeNull();
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
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Watch build", kind: "monitor", awaited: true },
      ],
    });

    expect(shell.runtime).toMatchObject({ status: "failed", lastError: "Provider turn failed" });
    expect(shell.pendingBackgroundTasks).toHaveLength(1);
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
      status: "running",
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Watch build", kind: "monitor", awaited: true },
      ],
    });

    expect(shell.latestRun).toMatchObject({ runId, status: "running" });
    expect(shell.runtime).toMatchObject({
      status: "idle",
      activeRunId: runId,
    });
    expect(shell.pendingBackgroundTasks).toEqual([
      { taskId: "bg-1", description: "Watch build", kind: "monitor", awaited: true },
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

    for (const held of [{ kind: "monitor", awaited: true }, { kind: "background_task" }] as const) {
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
        pendingBackgroundTasks: [{ taskId: "background-task", ...held }],
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
