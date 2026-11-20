import type { IssueAutomationAction } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** An action, or "unchanged" for a status no rule maps. */
export type IssueAutomationDecision = IssueAutomationAction | "unchanged";

/** Why the orchestrator refuses an action, matched by the service to keep it waiting. */
export const ISSUE_AUTOMATION_WAITS_FOR_IDLE = "Issue automation waits for an idle thread.";
export const ISSUE_AUTOMATION_STALE = "Issue automation snapshot is stale.";

/**
 * One action for a thread from its linked issues: any wake wins, every issue must settle for the
 * thread to settle, and otherwise it snoozes. An unread (null) or unmapped status changes nothing.
 */
export function aggregateIssueActions(
  actions: ReadonlyArray<IssueAutomationDecision | null>,
): IssueAutomationDecision {
  if (actions.includes("wake")) return "wake";
  if (actions.length === 0 || actions.some((action) => action === null || action === "unchanged"))
    return "unchanged";
  return actions.every((action) => action === "settle") ? "settle" : "snooze";
}

/** Only a known status moving to another known status counts; the first read is a baseline. */
export function changedIssueStatuses(
  previous: Readonly<Record<string, string | null>> | null,
  current: Readonly<Record<string, string | null>>,
): boolean {
  return (
    previous !== null &&
    Object.entries(current).some(
      ([key, state]) => state !== null && previous[key] != null && previous[key] !== state,
    )
  );
}

export const automationFingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
