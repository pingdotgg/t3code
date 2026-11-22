import type { SidebarAutoSettleReadiness } from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  isPullRequestWatchTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { SidebarThreadSummary } from "../../types";

export type SettleCheckId =
  | "kept-active"
  | "pinned"
  | "auto-settle-off"
  | "waiting-on-you"
  | "working"
  | "watching-pull-request"
  | "snoozed"
  | "latest-run-failed"
  | "unread-reply"
  | "terminal-running";

export interface SettleCheck {
  readonly id: SettleCheckId;
  readonly passed: boolean;
}

export type SettleReadinessThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "settledOverride"
  | "pinnedAt"
  | "autoSettleDisabledAt"
  | "pendingGuestMessageCount"
> & {
  readonly pendingBackgroundTasks: ReadonlyArray<
    Pick<SidebarThreadSummary["pendingBackgroundTasks"][number], "kind" | "taskId" | "awaited">
  >;
  readonly source: Pick<
    SidebarThreadSummary["source"],
    "status" | "activityRunStatus" | "pendingRuntimeRequest"
  >;
};

/**
 * Mirrors the server's automatic settlement holds (ThreadSettlementService), so the
 * trace says why auto-settle would or would not settle this thread.
 */
export function settleReadinessTrace(
  thread: SettleReadinessThread,
  options: {
    readonly readiness: SidebarAutoSettleReadiness;
    readonly snoozed: boolean;
    readonly unread: boolean;
    /** A terminal program the server would not stop on settle is still running. */
    readonly terminalRunning: boolean;
  },
): { readonly ready: boolean; readonly checks: ReadonlyArray<SettleCheck> } | null {
  if (thread.archivedAt !== null || thread.settledOverride === "settled") return null;
  const tasks = thread.pendingBackgroundTasks;
  const checks: SettleCheck[] = [
    { id: "kept-active", passed: thread.settledOverride === null },
    { id: "pinned", passed: thread.pinnedAt == null },
    { id: "auto-settle-off", passed: thread.autoSettleDisabledAt == null },
    {
      id: "waiting-on-you",
      passed:
        thread.source.pendingRuntimeRequest === null &&
        (thread.pendingGuestMessageCount ?? 0) === 0,
    },
    {
      id: "working",
      passed: thread.source.activityRunStatus == null && !backgroundWorkHoldsCompletion(tasks),
    },
    { id: "watching-pull-request", passed: !tasks.some(isPullRequestWatchTask) },
    { id: "snoozed", passed: !options.snoozed },
  ];
  if (options.readiness === "strict") {
    checks.push(
      { id: "latest-run-failed", passed: thread.source.status !== "failed" },
      { id: "unread-reply", passed: !options.unread },
    );
  }
  // The server checks terminals last, after the settings-based decision.
  checks.push({ id: "terminal-running", passed: !options.terminalRunning });
  return { ready: checks.every((check) => check.passed), checks };
}
