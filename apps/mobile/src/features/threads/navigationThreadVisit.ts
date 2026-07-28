import { scopedThreadKey } from "../../lib/scopedEntities";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

interface NavigationRouteLike {
  readonly name: string;
  readonly params?: unknown;
  readonly state?: NavigationStateLike;
}

export interface NavigationStateLike {
  readonly index?: number;
  readonly routes: readonly NavigationRouteLike[];
}

const THREAD_DESTINATION_ROUTES = new Set([
  "Thread",
  "ThreadTerminal",
  "ThreadReview",
  "ThreadReviewComment",
  "ThreadFiles",
  "ThreadFile",
  "GitOverview",
  "GitCommit",
  "GitBranches",
  "GitConfirm",
]);

function activeRoute(state: NavigationStateLike): NavigationRouteLike | null {
  const route = state.routes[state.index ?? state.routes.length - 1] ?? null;
  if (route?.state === undefined) return route;
  return activeRoute(route.state) ?? route;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  return typeof value[0] === "string" ? value[0] : null;
}

function parseTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function recordThreadVisit(
  current: Readonly<Record<string, string>>,
  threadKey: string,
  visitedAt: string,
  limit = 500,
): Readonly<Record<string, string>> {
  const next = { ...current, [threadKey]: visitedAt };
  const entries = Object.entries(next);
  if (entries.length <= limit) return next;
  return Object.fromEntries(
    entries
      .sort((left, right) => parseTimestampMs(right[1]) - parseTimestampMs(left[1]))
      .slice(0, limit),
  );
}

/**
 * Resolves the visible thread destination from React Navigation state.
 * Auxiliary thread routes (review, files, terminal, and git) count as visits
 * because the user is actively inspecting that thread there too.
 */
export function threadVisitKeyFromNavigationState(state: NavigationStateLike): string | null {
  const route = activeRoute(state);
  if (route === null || !THREAD_DESTINATION_ROUTES.has(route.name)) return null;
  if (typeof route.params !== "object" || route.params === null) return null;
  const params = route.params as Record<string, unknown>;
  const environmentId = firstString(params.environmentId);
  const threadId = firstString(params.threadId);
  if (environmentId === null || threadId === null) return null;
  return scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(threadId));
}
