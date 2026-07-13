import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { SUBAGENT_TASK_STALLED_THRESHOLD_MS } from "./subagentTaskActivity";

export interface ThreadHealth {
  readonly stalled: boolean;
  readonly lastActivityAt: Date;
  readonly stalledSince: Date | null;
}

export type ThreadHealthSortKey = readonly [createdAtMs: number, sequence: number];

export interface ThreadHealthProjectionState {
  readonly health: ThreadHealth | null;
  readonly sortKey: ThreadHealthSortKey | null;
}

const EMPTY_THREAD_HEALTH_PROJECTION: ThreadHealthProjectionState = {
  health: null,
  sortKey: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function compareSortKeys(left: ThreadHealthSortKey, right: ThreadHealthSortKey): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[1] - right[1];
}

function parseHealthActivity(
  activity: OrchestrationThreadActivity,
): { readonly health: ThreadHealth; readonly sortKey: ThreadHealthSortKey } | null {
  if (activity.kind !== "session.health") return null;
  const createdAt = parseDate(activity.createdAt);
  const payload = asRecord(activity.payload);
  if (!createdAt || !payload) return null;
  const state = payload.state;
  if (state !== "stalled" && state !== "active") return null;
  const lastActivityAt = parseDate(payload.lastActivityAt) ?? createdAt;
  return {
    health: {
      stalled: state === "stalled",
      lastActivityAt,
      stalledSince: state === "stalled" ? lastActivityAt : null,
    },
    sortKey: [createdAt.getTime(), activity.sequence ?? 0],
  };
}

export function applyThreadHealthActivity(
  prior: ThreadHealthProjectionState,
  activity: OrchestrationThreadActivity,
): ThreadHealthProjectionState {
  const next = parseHealthActivity(activity);
  if (!next) return prior;
  if (prior.sortKey && compareSortKeys(next.sortKey, prior.sortKey) <= 0) {
    return prior;
  }
  return next;
}

export function projectThreadHealth(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadHealth | null {
  let state = EMPTY_THREAD_HEALTH_PROJECTION;
  for (const activity of activities) {
    state = applyThreadHealthActivity(state, activity);
  }
  return state.health;
}

export function createThreadHealthProjectionState(
  activities: ReadonlyArray<OrchestrationThreadActivity> = [],
): ThreadHealthProjectionState {
  let state = EMPTY_THREAD_HEALTH_PROJECTION;
  for (const activity of activities) {
    state = applyThreadHealthActivity(state, activity);
  }
  return state;
}

export function isThreadHealthActiveFresh(health: ThreadHealth, nowMs: number): boolean {
  return nowMs - health.lastActivityAt.getTime() <= SUBAGENT_TASK_STALLED_THRESHOLD_MS;
}

export function threadHealthStalledForLabel(health: ThreadHealth, nowMs: number): string | null {
  if (!health.stalled || !health.stalledSince) return null;
  const seconds = Math.max(0, Math.floor((nowMs - health.stalledSince.getTime()) / 1000));
  if (seconds < 60) return `stalled for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `stalled for ${minutes}m`;
  return `stalled for ${Math.floor(minutes / 60)}h`;
}
