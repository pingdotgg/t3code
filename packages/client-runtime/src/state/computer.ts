import {
  type ComputerAction,
  type ComputerApproval,
  type ComputerSnapshot,
  type ComputerTaskView,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * What every client draws of computer use on one environment: the hosts it can use, the tasks
 * running or finished, and the approvals still answerable. Answers go through
 * `computer.respondToApproval`, which needs `computer:approve`.
 */
export function createComputerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:computer:state",
      tag: WS_METHODS.computerSubscribe,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:stop",
      tag: WS_METHODS.computerStop,
    }),
    respondToApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:respond-to-approval",
      tag: WS_METHODS.computerRespondToApproval,
    }),
    /** The newest audit lines, oldest first, for Settings. */
    audit: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:computer:audit",
      tag: WS_METHODS.computerAuditTail,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
  };
}

export const EMPTY_COMPUTER_SNAPSHOT: ComputerSnapshot = {
  hosts: [],
  tasks: [],
  approvals: [],
};

/** Approvals somebody can still answer: pending, and not past the 60 s they last. */
export function computerPendingApprovals(
  snapshot: ComputerSnapshot,
  nowMs: number,
): ReadonlyArray<ComputerApproval> {
  return snapshot.approvals.filter(
    (approval) =>
      approval.state === "pending" && DateTime.toEpochMillis(approval.expiresAt) > nowMs,
  );
}

function clipped(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

const quoted = (value: string) => `“${clipped(value, 120)}”`;

/**
 * One line for the step an approval covers. Screen text is data: it is quoted, clipped and never
 * read as an instruction.
 */
export function computerActionSentence(action: ComputerAction): string {
  const where = action.role && action.label ? `${action.role} ${quoted(action.label)}` : null;
  switch (action.kind) {
    case "click":
      return where === null ? "Click an element" : `Click ${where}`;
    case "type":
      return action.text === undefined
        ? "Type text"
        : `Type ${action.text.length} characters${where === null ? "" : ` into ${where}`}`;
    case "press":
      return action.key === undefined ? "Press a key" : `Press ${action.key}`;
    case "scroll":
      return action.direction === undefined
        ? "Scroll"
        : `Scroll ${action.direction}${where === null ? "" : ` on ${where}`}`;
    case "surface":
      return action.name === undefined
        ? `Bring the ${action.what ?? "app"} forward`
        : `Bring ${action.what ?? "app"} ${quoted(action.name)} forward`;
    case "pointer":
      return action.why === undefined ? "Use your mouse" : clipped(action.why, 160);
    default:
      return action.kind;
  }
}

/** The exact text a step types. Only a `type` step carries one, and it is the only text typed. */
export function computerApprovalTypedText(approval: ComputerApproval): string | null {
  return approval.binding.action.kind === "type" ? (approval.binding.action.text ?? null) : null;
}

/** Where the step happens: the app, the window and the page, when the helper knows them. */
export function computerApprovalSurface(approval: ComputerApproval): string {
  const { app, title, url } = approval.binding;
  const parts = [app, title]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => clipped(part, 160));
  const page = url.trim();
  if (page.length > 0) {
    const shown = clipped(page, 200);
    if (!parts.includes(shown)) parts.push(shown);
  }
  return parts.join(" · ");
}

/** The last step a running task took, for a strip row. */
export function computerTaskLastStep(task: ComputerTaskView): string | null {
  const last = task.steps[task.steps.length - 1];
  return last === undefined || last.trim().length === 0 ? null : clipped(last, 160);
}

/**
 * When the next pending approval lapses, so a view re-renders once at that moment instead of on a
 * timer. Null when nothing waits.
 */
export function nextComputerApprovalDeadline(snapshot: ComputerSnapshot): number | null {
  let next: number | null = null;
  for (const approval of snapshot.approvals) {
    if (approval.state !== "pending") continue;
    const expiresAtMs = DateTime.toEpochMillis(approval.expiresAt);
    if (next === null || expiresAtMs < next) next = expiresAtMs;
  }
  return next;
}
