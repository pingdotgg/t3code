import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { toSortableTimestamp } from "./threadSort";

// One-shot capture animation (ScreenshotCaptureCoordinator): a floating
// thumbnail springing onto the composer chip. The camera flash itself is
// native — the helper shows it over the captured window.
export const SCREENSHOT_FLIGHT_DURATION_MS = 520;

export interface ScreenshotTargetThreadShell {
  readonly id: ScopedThreadRef["threadId"];
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly archivedAt: string | null;
}

/**
 * Where a screenshot should land when no composer is on the current route:
 * the most recently visited thread that still exists and is not archived.
 * Returns null when nothing qualifies (fresh profile, all visits stale).
 *
 * Visits are keyed by scoped thread key (`environmentId:threadId`) — see
 * markThreadVisited call sites — never by the bare thread id.
 */
export function resolveScreenshotNavigationTarget(
  shells: ReadonlyArray<ScreenshotTargetThreadShell>,
  threadLastVisitedAtById: Readonly<Record<string, string>>,
): ScopedThreadRef | null {
  let best: ScreenshotTargetThreadShell | null = null;
  let bestVisitedAt = Number.NEGATIVE_INFINITY;
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    const visitedAtIso =
      threadLastVisitedAtById[scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))];
    const visitedAt = toSortableTimestamp(visitedAtIso);
    if (visitedAt === null) continue;
    if (visitedAt > bestVisitedAt) {
      best = shell;
      bestVisitedAt = visitedAt;
    }
  }
  return best === null ? null : { environmentId: best.environmentId, threadId: best.id };
}

export function buildScreenshotFileName(appName: string | undefined, capturedAt: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${capturedAt.getFullYear()}-${pad(capturedAt.getMonth() + 1)}-${pad(
    capturedAt.getDate(),
  )}-${pad(capturedAt.getHours())}${pad(capturedAt.getMinutes())}${pad(capturedAt.getSeconds())}`;
  const slug = appName
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `screenshot-${slug}-${stamp}.png` : `screenshot-${stamp}.png`;
}
