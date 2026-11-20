import { selectWidgetActivities } from "@t3tools/shared/agentAwareness";
import type { AgentWidgetSnapshot } from "../agentWidgetSnapshot";

/** Bounded by WidgetKit's App Group defaults and extension memory; 5 rows are visible. */
const PROJECT_ICON_LIMIT = 8;
const FRESHNESS_MS = 25 * 60_000;

const projectIconKey = (
  row: Pick<AgentWidgetSnapshot["activities"][number], "environmentId" | "projectId">,
) => (row.projectId != null ? `${row.environmentId}:${row.projectId}` : null);

/**
 * Icons belong to a project, not a turn. They resolve only while the app is open,
 * so every write carries the last known bitmap forward in `projectIcons`, including
 * for projects that a background push rotated out of the visible rows.
 */
export function carryProjectIcons(
  snapshot: AgentWidgetSnapshot,
  previous?: AgentWidgetSnapshot,
): AgentWidgetSnapshot {
  const icons = new Map(Object.entries(previous?.projectIcons ?? {}));
  for (const row of [...(snapshot.work?.review ?? []), ...(snapshot.work?.recent ?? [])]) {
    const key = projectIconKey(row);
    const icon = key && snapshot.projectIcons?.[key];
    if (!key || !icon) continue;
    icons.delete(key);
    icons.set(key, icon);
  }
  for (const row of [...(previous?.activities ?? []), ...snapshot.activities]) {
    const key = projectIconKey(row);
    if (!key || !row.projectIcon) continue;
    icons.delete(key);
    icons.set(key, row.projectIcon);
  }
  const projectIcons = Object.fromEntries([...icons].slice(-PROJECT_ICON_LIMIT));
  const activities = snapshot.activities.map((row) => {
    if (row.projectIcon) return row;
    const key = projectIconKey(row);
    const icon = key
      ? projectIcons[key]
      : [...snapshot.activities, ...(previous?.activities ?? [])].find(
          (other) =>
            other.projectIcon &&
            other.environmentId === row.environmentId &&
            other.threadId === row.threadId,
        )?.projectIcon;
    return icon ? { ...row, projectIcon: icon } : row;
  });
  return { ...snapshot, activities, projectIcons };
}

/** A cached shell or late icon load must not roll back a more recent server push. */
export function reconcileOverviewSnapshot(
  snapshot: AgentWidgetSnapshot,
  previous?: AgentWidgetSnapshot,
  liveEnvironments: readonly string[] = [],
  checkedAt = new Date().toISOString(),
): AgentWidgetSnapshot {
  const environments = snapshot.environments?.map((current) => {
    const cached = previous?.environments?.find(
      (entry) => entry.environmentId === current.environmentId,
    );
    const latest =
      cached?.snapshot.updatedAt &&
      (!current.snapshot.updatedAt || cached.snapshot.updatedAt > current.snapshot.updatedAt)
        ? cached
        : current;
    const observedAt =
      latest === current && liveEnvironments.includes(current.environmentId)
        ? checkedAt
        : cached?.snapshot.checkedAt;
    return observedAt
      ? { ...latest, snapshot: { ...latest.snapshot, checkedAt: observedAt } }
      : latest;
  });
  const merged = environments
    ? {
        ...snapshot,
        environments,
        activeCount: environments.reduce((sum, entry) => sum + entry.snapshot.activeCount, 0),
        attentionCount: environments.reduce((sum, entry) => sum + entry.snapshot.attentionCount, 0),
        updatedAt: environments.reduce<string | null>(
          (latest, entry) =>
            entry.snapshot.updatedAt && (!latest || entry.snapshot.updatedAt > latest)
              ? entry.snapshot.updatedAt
              : latest,
          null,
        ),
        activities: selectWidgetActivities(
          environments.flatMap((entry) => entry.snapshot.activities),
          Date.now(),
        ).slice(0, 5),
      }
    : snapshot;
  return {
    ...merged,
    activities: merged.activities.map((row) => {
      const cached = previous?.activities.find(
        (other) =>
          other.environmentId === row.environmentId &&
          other.threadId === row.threadId &&
          other.phase === row.phase &&
          other.turnId === row.turnId,
      );
      return { ...row, ...(cached?.summary && !row.summary ? { summary: cached.summary } : {}) };
    }),
  };
}

export function overviewMetrics(snapshot: AgentWidgetSnapshot) {
  const sources = snapshot.environments?.map((entry) => entry.snapshot) ?? [snapshot];
  const approvals = sources.map((source) => {
    if (source.approvalCount !== undefined) return source.approvalCount;
    const waiting = source.activities.filter((row) => row.phase.startsWith("waiting"));
    return waiting.length === source.attentionCount
      ? waiting.filter((row) => row.phase === "waiting_for_approval").length
      : undefined;
  });
  const projects = sources.map((source) =>
    source.activeCount === 0 ? 0 : source.activeProjectCount,
  );
  const sumKnown = (values: readonly (number | undefined)[]) =>
    values.every((value) => value !== undefined)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : undefined;
  const deadlines = sources.flatMap((source) => {
    if (source.activeCount === 0) return [];
    const verified = Math.max(
      Date.parse(source.checkedAt ?? "") || 0,
      Date.parse(source.updatedAt ?? "") || 0,
    );
    return verified > 0 ? [verified + FRESHNESS_MS] : [0];
  });
  return {
    approvalCount: sumKnown(approvals),
    activeProjectCount: sumKnown(projects),
    overviewStaleAt: deadlines.length > 0 ? Math.min(...deadlines) : undefined,
  };
}
