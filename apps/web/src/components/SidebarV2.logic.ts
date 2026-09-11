import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  firstValidTimestampMs,
  resolveSidebarThreadStatus,
  resolveWorkingStartedAt,
} from "./Sidebar.logic";

export {
  buildWorktreeThreadGroups as buildSidebarWorktreeGroups,
  pickWorktreeGroupRepresentative,
  sidebarThreadKey,
  type WorktreeThreadGroup as SidebarWorktreeGroup,
  type WorktreeThreadClassification as SidebarThreadClassification,
} from "@t3tools/client-runtime/state/worktree-grouping";

/** Card-level live status: what the worktree as a whole is doing, ranked by
    how urgently it needs the user (act now > answer > in motion > broken).
    Per-thread Done/Woke signals stay on the member rows — this is only the
    shells-derived aggregate for the card's top-right slot. */
export function resolveWorktreeGroupLiveStatus(threads: ReadonlyArray<EnvironmentThreadShell>): {
  kind: "approval" | "input" | "working" | "failed";
  workingStartedAt: string | null;
} | null {
  let hasApproval = false;
  let hasInput = false;
  let hasFailed = false;
  let hasWorking = false;
  let workingStartedAt: string | null = null;
  let workingStartedAtMs = Number.POSITIVE_INFINITY;
  for (const thread of threads) {
    const status = resolveSidebarThreadStatus(thread);
    if (status === "approval") hasApproval = true;
    else if (status === "input") hasInput = true;
    else if (status === "failed") hasFailed = true;
    else if (status === "working") {
      hasWorking = true;
      const startedAt = resolveWorkingStartedAt(thread);
      const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
      // Earliest running start wins: the card counts the oldest in-flight
      // work, not the most recently kicked-off member.
      if (!Number.isNaN(startedMs) && startedMs < workingStartedAtMs) {
        workingStartedAt = startedAt;
        workingStartedAtMs = startedMs;
      }
    }
  }
  if (hasApproval) return { kind: "approval", workingStartedAt: null };
  if (hasInput) return { kind: "input", workingStartedAt: null };
  if (hasWorking) return { kind: "working", workingStartedAt };
  if (hasFailed) return { kind: "failed", workingStartedAt: null };
  return null;
}

/** The member whose latest activity stamps the card's resting time label. */
export function pickWorktreeGroupTimeLabelThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell {
  return threads.reduce((latest, thread) => {
    const latestMs = firstValidTimestampMs(latest.latestUserMessageAt, latest.updatedAt);
    const threadMs = firstValidTimestampMs(thread.latestUserMessageAt, thread.updatedAt);
    return threadMs >= latestMs ? thread : latest;
  });
}
