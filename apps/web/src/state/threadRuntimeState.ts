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
  /** Full card border set in the state's hue. */
  readonly borderClass: string;
  /** Foreground utility for status text set in the state's hue. */
  readonly textClass: string;
  /** Card surface mixed very lightly toward the state's hue. */
  readonly surfaceClass: string;
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
    borderClass: "border-amber-500/50 dark:border-amber-300/40",
    textClass: "text-amber-600 dark:text-amber-300/90",
    surfaceClass: "bg-[color-mix(in_srgb,var(--card)_96%,var(--color-amber-500))]",
  },
  input: {
    label: "Input",
    borderClass: "border-indigo-500/50 dark:border-indigo-300/40",
    textClass: "text-indigo-600 dark:text-indigo-300/90",
    surfaceClass: "bg-[color-mix(in_srgb,var(--card)_96%,var(--color-indigo-500))]",
  },
  working: {
    label: "Working",
    borderClass: "border-sky-500/50 dark:border-sky-300/40",
    textClass: "text-sky-600 dark:text-sky-300/80",
    surfaceClass: "bg-[color-mix(in_srgb,var(--card)_96%,var(--color-sky-500))]",
  },
  monitoring: {
    label: "Monitoring",
    borderClass: "border-sky-500/50 dark:border-sky-300/40",
    textClass: "text-sky-600 dark:text-sky-300/80",
    surfaceClass: "bg-[color-mix(in_srgb,var(--card)_96%,var(--color-sky-500))]",
  },
  connecting: {
    label: "Connecting",
    borderClass: "border-sky-500/50 dark:border-sky-300/40",
    textClass: "text-sky-600 dark:text-sky-300/80",
    surfaceClass: "bg-[color-mix(in_srgb,var(--card)_96%,var(--color-sky-500))]",
  },
  failed: {
    label: "Failed",
    borderClass: "border-red-500/50 dark:border-red-300/40",
    textClass: "text-red-600 dark:text-red-300/90",
    surfaceClass: "bg-[color-mix(in_srgb,var(--card)_96%,var(--color-red-500))]",
  },
  "plan-ready": {
    label: "Plan ready",
    borderClass: "border-violet-500/50 dark:border-violet-300/40",
    textClass: "text-violet-600 dark:text-violet-300/90",
    surfaceClass: "bg-[color-mix(in_srgb,var(--card)_96%,var(--color-violet-500))]",
  },
  idle: {
    label: "Idle",
    borderClass: "border-border/70",
    textClass: "text-muted-foreground",
    surfaceClass: "bg-card",
  },
};

export function threadRuntimeStateAppearance(
  state: ThreadRuntimeState,
): ThreadRuntimeStateAppearance {
  return THREAD_RUNTIME_STATE_APPEARANCE[state];
}
