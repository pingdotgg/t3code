import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
  scheduledTasksWakeThread,
  threadHasNoPendingWake,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first.returnedAt(thread("a", true))).toBeUndefined();
    expect(first.returnedAt(thread("b", false))).toBeUndefined();

    const held = tracker.observe([thread("a", false), thread("b", false)]);
    vi.advanceTimersByTime(2_000);
    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second.returnedAt(thread("a", false))).toBeDefined();
    expect(second.returnedAt(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second.returnedAt(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(held.isWorking(thread("a", false))).toBe(true);
    expect(held.returnedAt(thread("a", false))).toBeUndefined();
  });

  it("holds only placement, then expires and notifies without another shell event", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    const unsubscribe = tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    expect(isThreadWorking(thread("a", false))).toBe(false);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1_999);
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(12_000);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("cancels a transient return on resume and grants a fresh grace after the next finish", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    tracker.observe([thread("a", true)]);
    expect(tracker.isWorking(thread("a", true))).toBe(true);
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_500);
    tracker.observe([thread("a", true)]);
    vi.advanceTimersByTime(1_000);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.returnedAt(thread("a", false))).toBe(14_500);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { pendingSubagentRequest: "user_input" as const },
    { pendingGuestMessageCount: 1 },
    { interactionMode: "plan" as const, hasActionableProposedPlan: true },
    { runtime: { ...thread("a", true).runtime!, status: "failed" as const, lastError: "failed" } },
    { pinnedAt: "2026-06-01T00:00:01Z" },
    { settledOverride: "settled" as const },
    { snoozedUntil: "2026-06-02T00:00:00Z" },
    { activeOrderKey: "manual-order" },
  ])("ends a grace immediately for attention or manual placement: %j", (change) => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([{ ...thread("a", false), ...change }]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["interrupted", "cancelled", "rolled_back"] as const)(
    "holds a %s run, because the server can still settle it",
    (status) => {
      const tracker = createInboxReturnTracker();
      const stopped = {
        ...thread("a", false),
        latestRun: {
          runId: RunId.make("stopped"),
          status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      };
      tracker.observe([thread("a", true)]);
      tracker.observe([stopped]);
      expect(tracker.isWorking(stopped)).toBe(true);
      tracker.observe([{ ...stopped, settledOverride: "settled" as const }]);
      expect(tracker.isWorking(stopped)).toBe(false);
    },
  );

  it("grants grace after a retained expired snooze", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:05.000Z",
      latestRun: {
        runId: RunId.make("completed-wake"),
        status: "completed" as const,
        requestedAt: "1970-01-01T00:00:02.000Z",
        startedAt: "1970-01-01T00:00:02.000Z",
        completedAt: "1970-01-01T00:00:09.000Z",
        assistantMessageId: null,
      },
    };
    const active = { ...thread("a", true), ...retained };
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([active]);
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(true);
    expect(tracker.returnedAt(finished)).toBeUndefined();
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(finished)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(tracker.returnedAt(finished)).toBe(12_000);
  });

  it("does not grant grace to a future snooze after background completion", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:30.000Z",
    };
    tracker.observe([{ ...thread("a", true), ...retained }]);
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stamps only stable returns and sorts them in their actual return order", () => {
    const tracker = createInboxReturnTracker();
    const a = { ...thread("a", false), createdAt: "1970-01-01T00:00:00Z" };
    const b = { ...thread("b", false), createdAt: "1970-01-01T00:00:00Z" };
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([a, thread("b", true)]);
    vi.advanceTimersByTime(500);
    tracker.observe([a, b]);
    vi.advanceTimersByTime(1_500);
    expect(tracker.returnedAt(a)).toBe(12_000);
    expect(tracker.returnedAt(b)).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(sortInboxThreadsByReturn([a, b], tracker.returnedAt).map((entry) => entry.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("cancels pending timers for removed threads and disabled shelves", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([]);
    expect(vi.getTimerCount()).toBe(0);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe(null);
    vi.advanceTimersByTime(2_000);
    expect(notify).not.toHaveBeenCalled();
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("threadHasNoPendingWake", () => {
  const runId = RunId.make("run-ended");
  const ended = { ...v2ThreadShell, latestRunId: runId, status: "completed" as const };
  const present = (shell: Partial<OrchestrationV2ThreadShell>) =>
    presentThreadShell(environmentId, { ...ended, hasHeldQueue: false, ...shell });
  const request = (kind: "user_input" | "dynamic_tool_call") => ({
    id: RuntimeRequestId.make("request-open"),
    kind,
    createdAt: v2ThreadShell.updatedAt,
  });
  const watch = {
    taskId: "pull-request-watch:github.com/acme/app#1",
    kind: "monitor" as const,
    awaited: true as const,
  };

  it("is idle once the turn ended with nothing that could resume it", () => {
    for (const status of ["completed", "interrupted", "cancelled"] as const) {
      expect(threadHasNoPendingWake(present({ status }), false)).toBe(true);
    }
  });

  it.each([
    { name: "no turn ran yet", shell: { latestRunId: null, status: "idle" as const } },
    { name: "a turn is running", shell: { activeRunId: runId, status: "running" as const } },
    { name: "the turn awaits its checkpoint", shell: { status: "waiting" as const } },
    { name: "the turn failed", shell: { status: "failed" as const } },
    // A rolled-back latest run hides the pending work list, watches included.
    { name: "the turn was rolled back", shell: { status: "rolled_back" as const } },
    {
      name: "an awaited background command runs",
      shell: {
        pendingBackgroundTasks: [
          { taskId: "tests", kind: "command" as const, awaited: true as const },
        ],
      },
    },
    {
      // Claude wakes the agent when any background command it started exits.
      name: "an unawaited background command runs",
      shell: { pendingBackgroundTasks: [{ taskId: "build", kind: "command" as const }] },
    },
    {
      name: "a delegated thread is open",
      shell: {
        pendingBackgroundTasks: [
          { taskId: "delegate", kind: "subagent" as const, childThreadId: ThreadId.make("child") },
        ],
      },
    },
    { name: "a pull request is watched", shell: { pendingBackgroundTasks: [watch] } },
    {
      name: "an approval is pending",
      shell: { pendingRuntimeRequest: request("dynamic_tool_call") },
    },
    { name: "a question is pending", shell: { pendingRuntimeRequest: request("user_input") } },
    { name: "a guest message waits", shell: { pendingGuestMessageCount: 1 } },
    // Includes a message queued during the turn and held by a stop, which predates the turn's end.
    { name: "a message waits in a held queue", shell: { hasHeldQueue: true } },
  ])("is not idle when $name", ({ shell }) => {
    expect(threadHasNoPendingWake(present(shell), false)).toBe(false);
  });

  it("is not idle while a child thread asks for approval or input", () => {
    for (const childRequest of ["approval", "user_input"] as const) {
      const shell = presentThreadShell(
        environmentId,
        { ...ended, hasHeldQueue: false },
        childRequest,
      );
      expect(threadHasNoPendingWake(shell, false)).toBe(false);
    }
  });

  it("is not idle when an older server does not report its held queue", () => {
    expect(threadHasNoPendingWake(presentThreadShell(environmentId, ended), false)).toBe(false);
  });

  it("is not idle while a scheduled task can run into it, or before the task list loads", () => {
    expect(threadHasNoPendingWake(present({}), true)).toBe(false);
    expect(threadHasNoPendingWake(present({}), null)).toBe(false);
  });
});

describe("scheduledTasksWakeThread", () => {
  const threadId = v2ThreadShell.id;
  const task = (
    overrides: Partial<
      Pick<ScheduledTask, "threadId" | "enabled" | "nextRunAt" | "schedule" | "blockedByPolicy">
    > = {},
  ) => ({
    threadId,
    enabled: true,
    nextRunAt: "2026-06-21T00:00:00.000Z",
    schedule: { type: "interval" as const, everyMs: 3_600_000 },
    ...overrides,
  });

  it("counts a bound task with a next run or an enabled webhook", () => {
    expect(scheduledTasksWakeThread([task()], threadId)).toBe(true);
    const webhook = task({ nextRunAt: null, schedule: { type: "webhook", signature: null } });
    expect(scheduledTasksWakeThread([webhook], threadId)).toBe(true);
  });

  it("ignores tasks that cannot run into this thread again", () => {
    const tasks = [
      task({ threadId: ThreadId.make("other-thread") }),
      task({ threadId: null }),
      task({ enabled: false, nextRunAt: null }),
      task({ nextRunAt: null, schedule: { type: "once", runAt: "2026-06-19T00:00:00.000Z" } }),
      task({ blockedByPolicy: "Webhooks are disabled by policy." }),
    ];
    expect(scheduledTasksWakeThread(tasks, threadId)).toBe(false);
  });
});
