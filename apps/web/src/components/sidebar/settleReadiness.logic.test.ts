import { describe, expect, it } from "vite-plus/test";

import { settleReadinessTrace, type SettleReadinessThread } from "./settleReadiness.logic";

function thread(overrides: Partial<SettleReadinessThread> = {}): SettleReadinessThread {
  return {
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    autoSettleDisabledAt: null,
    pendingGuestMessageCount: 0,
    pendingBackgroundTasks: [],
    source: { status: "completed", activityRunStatus: null, pendingRuntimeRequest: null },
    ...overrides,
  };
}

const failedIds = (trace: ReturnType<typeof settleReadinessTrace>) =>
  trace?.checks.filter((check) => !check.passed).map((check) => check.id);

describe("settleReadinessTrace", () => {
  it("adds the failed-run and unread-reply checks only for strict readiness", () => {
    const failedUnread = thread({ source: { ...thread().source, status: "failed" } });
    const options = { snoozed: false, unread: true, terminalRunning: false };
    const defaultTrace = settleReadinessTrace(failedUnread, { ...options, readiness: "default" });
    expect(defaultTrace?.ready).toBe(true);
    expect(defaultTrace?.checks.map((check) => check.id)).not.toContain("unread-reply");

    const strictTrace = settleReadinessTrace(failedUnread, { ...options, readiness: "strict" });
    expect(strictTrace?.ready).toBe(false);
    expect(failedIds(strictTrace)).toEqual(["latest-run-failed", "unread-reply"]);
  });

  it("names every hold the server applies, and has no trace for archived or settled threads", () => {
    const held = thread({
      settledOverride: "active",
      pinnedAt: "2026-06-10T00:00:00.000Z",
      autoSettleDisabledAt: "2026-06-10T00:00:00.000Z",
      pendingGuestMessageCount: 1,
      pendingBackgroundTasks: [{ taskId: "pull-request-watch:42", kind: "monitor" }],
      source: { status: "running", activityRunStatus: "running", pendingRuntimeRequest: null },
    });
    expect(
      failedIds(
        settleReadinessTrace(held, {
          readiness: "default",
          snoozed: true,
          unread: false,
          terminalRunning: true,
        }),
      ),
    ).toEqual([
      "kept-active",
      "pinned",
      "auto-settle-off",
      "waiting-on-you",
      "working",
      "watching-pull-request",
      "snoozed",
      "terminal-running",
    ]);
    const options = {
      readiness: "strict" as const,
      snoozed: false,
      unread: false,
      terminalRunning: false,
    };
    expect(
      settleReadinessTrace(thread({ archivedAt: "2026-06-10T00:00:00.000Z" }), options),
    ).toBeNull();
    expect(settleReadinessTrace(thread({ settledOverride: "settled" }), options)).toBeNull();
  });
});
