import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { isLatestTurnSettled } from "../session-logic";

export type ThreadRuntimeState =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "connecting"
  | "failed"
  | "plan-ready"
  | "idle";

export type ThreadRuntimeStateInput = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session"
> &
  Partial<
    Pick<
      OrchestrationThreadShell,
      "backgroundLiveness" | "hasActionableProposedPlan" | "interactionMode" | "latestTurn"
    >
  >;

/** Canonical precedence for native thread runtime state. */
export function resolveThreadRuntimeState(thread: ThreadRuntimeStateInput): ThreadRuntimeState {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";

  if (thread.session?.status === "running") return "working";
  if (thread.session?.status === "starting") return "connecting";
  if (thread.session?.status === "error") return "failed";

  if (
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn ?? null, thread.session) &&
    thread.hasActionableProposedPlan
  ) {
    return "plan-ready";
  }

  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";

  return "idle";
}

export interface ThreadRuntimeStateAppearance {
  /** Human label, matching the wording the sidebar status pills already use. */
  readonly label: string;
  /** Background utility for a status dot or edge accent. */
  readonly accentClass: string;
  /** Foreground utility for status text set in the state's hue. */
  readonly textClass: string;
  /** Whether the state is in motion and should pulse. */
  readonly pulse: boolean;
}

// One hue per runtime state, shared by every surface that shows thread status.
// The hues are the system-wide convention already set by sidebar v1/v2 and the
// mobile Live Activity/widgets — amber approval, indigo input, sky working,
// violet plan-ready — so a thread reads the same color wherever it surfaces.
// Anything new that paints thread status reads it from here rather than
// picking its own palette.
const THREAD_RUNTIME_STATE_APPEARANCE: Readonly<
  Record<ThreadRuntimeState, ThreadRuntimeStateAppearance>
> = {
  approval: {
    label: "Approval",
    accentClass: "bg-amber-500 dark:bg-amber-300/90",
    textClass: "text-amber-600 dark:text-amber-300/90",
    pulse: false,
  },
  input: {
    label: "Input",
    accentClass: "bg-indigo-500 dark:bg-indigo-300/90",
    textClass: "text-indigo-600 dark:text-indigo-300/90",
    pulse: false,
  },
  working: {
    label: "Working",
    accentClass: "bg-sky-500 dark:bg-sky-300/80",
    textClass: "text-sky-600 dark:text-sky-300/80",
    pulse: true,
  },
  monitoring: {
    label: "Monitoring",
    accentClass: "bg-sky-500 dark:bg-sky-300/80",
    textClass: "text-sky-600 dark:text-sky-300/80",
    pulse: false,
  },
  connecting: {
    label: "Connecting",
    accentClass: "bg-sky-500 dark:bg-sky-300/80",
    textClass: "text-sky-600 dark:text-sky-300/80",
    pulse: true,
  },
  failed: {
    label: "Failed",
    accentClass: "bg-red-500 dark:bg-red-300/90",
    textClass: "text-red-600 dark:text-red-300/90",
    pulse: false,
  },
  "plan-ready": {
    label: "Plan ready",
    accentClass: "bg-violet-500 dark:bg-violet-300/90",
    textClass: "text-violet-600 dark:text-violet-300/90",
    pulse: false,
  },
  idle: {
    label: "Idle",
    accentClass: "bg-muted-foreground/40",
    textClass: "text-muted-foreground",
    pulse: false,
  },
};

export function threadRuntimeStateAppearance(
  state: ThreadRuntimeState,
): ThreadRuntimeStateAppearance {
  return THREAD_RUNTIME_STATE_APPEARANCE[state];
}
