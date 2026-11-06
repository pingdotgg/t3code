import type { AgentActivityProps } from "./AgentActivity";

export const AGENT_ACTIVITY_FRESHNESS_MS = 10 * 60_000;

/** Expiration is precomputed so WidgetKit can age observations while JS is suspended. */
export function agentActivityTimeline(props: AgentActivityProps, now: number) {
  const expiresAt = props.expiresAt;
  // Expo stores timelines in UserDefaults, whose property lists cannot contain
  // null. The layout treats a negative count as unavailable.
  const current = { ...props, activeCount: props.activeCount ?? -1 };
  const expired: AgentActivityProps = {
    ...props,
    activeCount: -1,
    isExpired: true,
    subtitle: "Open T3 to refresh",
    activities: props.activities.map((row) =>
      row.phase === "completed" || row.phase === "failed"
        ? row
        : { ...row, phase: "stale", status: "Out of date" },
    ),
  };
  if (expiresAt === undefined) return [{ date: new Date(now), props: current }];
  if (expiresAt <= now) return [{ date: new Date(now), props: expired }];
  return [
    { date: new Date(now), props: current },
    { date: new Date(expiresAt), props: expired },
  ];
}
