import type { OrchestrationThreadShell } from "@t3tools/contracts";

/**
 * Shared visual vocabulary for the TUI, mirroring the web sidebar's status pills
 * (apps/web/src/components/Sidebar.logic.ts `resolveThreadStatusPill`) and
 * relative-time labels (apps/web/src/timestampFormat.ts). Web colours map to the
 * named ANSI colours Ink supports: amber→yellow, indigo/violet→magenta,
 * sky→cyan, emerald→green.
 */
export interface ThreadStatus {
  readonly key: string;
  /** Single-cell glyph for a status dot. */
  readonly glyph: string;
  readonly color: string;
  readonly bold: boolean;
  readonly label: string;
  /** Lower = higher priority (used to aggregate a project's status). */
  readonly rank: number;
}

const PENDING_APPROVAL: ThreadStatus = {
  key: "pending-approval",
  glyph: "◆",
  color: "red",
  bold: true,
  label: "Pending approval",
  rank: 0,
};
const AWAITING_INPUT: ThreadStatus = {
  key: "awaiting-input",
  glyph: "◆",
  color: "yellow",
  bold: true,
  label: "Awaiting input",
  rank: 1,
};
const PLAN_READY: ThreadStatus = {
  key: "plan-ready",
  glyph: "◇",
  color: "magenta",
  bold: false,
  label: "Plan ready",
  rank: 2,
};
const WORKING: ThreadStatus = {
  key: "working",
  glyph: "●",
  color: "green",
  bold: true,
  label: "Working",
  rank: 3,
};
const CONNECTING: ThreadStatus = {
  key: "connecting",
  glyph: "◌",
  color: "cyan",
  bold: false,
  label: "Connecting",
  rank: 4,
};
const ERRORED: ThreadStatus = {
  key: "error",
  glyph: "✕",
  color: "red",
  bold: true,
  label: "Error",
  rank: 5,
};
const READY: ThreadStatus = {
  key: "ready",
  glyph: "○",
  color: "cyan",
  bold: false,
  label: "Ready",
  rank: 6,
};
const COMPLETED: ThreadStatus = {
  key: "completed",
  glyph: "✓",
  color: "green",
  bold: false,
  label: "Completed",
  rank: 7,
};
const IDLE: ThreadStatus = {
  key: "idle",
  glyph: "○",
  color: "gray",
  bold: false,
  label: "Idle",
  rank: 8,
};

/**
 * Resolve a thread's status to a dot, in the same priority order the web sidebar
 * uses. Always returns a status (idle is the fallback) so list rows show a dot.
 */
export function resolveThreadStatus(thread: OrchestrationThreadShell): ThreadStatus {
  if (thread.hasPendingApprovals) return PENDING_APPROVAL;
  if (thread.hasPendingUserInput) return AWAITING_INPUT;
  if (thread.hasActionableProposedPlan) return PLAN_READY;
  switch (thread.session?.status) {
    case "running":
      return WORKING;
    case "starting":
      return CONNECTING;
    case "error":
      return ERRORED;
    case "ready":
      return READY;
    case "stopped":
      return COMPLETED;
    default:
      return IDLE;
  }
}

/**
 * Highest-priority non-idle status across a project's threads, or null when every
 * thread is idle (mirrors the web's `resolveProjectStatusIndicator`).
 */
export function resolveProjectStatus(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): ThreadStatus | null {
  let best: ThreadStatus | null = null;
  for (const thread of threads) {
    const status = resolveThreadStatus(thread);
    if (status.key === IDLE.key) continue;
    if (best === null || status.rank < best.rank) best = status;
  }
  return best;
}

/** Colour for a bare session status label (used in the conversation header). */
export function sessionStatusColor(status: string | null | undefined): string {
  switch (status) {
    case "running":
    case "stopped":
      return "green";
    case "starting":
    case "ready":
      return "cyan";
    case "error":
      return "red";
    default:
      return "gray";
  }
}

/** Compact relative time (≤3 chars): now / 2m / 3h / 5d — same thresholds as web. */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
