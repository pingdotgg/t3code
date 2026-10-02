import type { AgentActivityProps } from "./AgentActivity";

export const AGENT_ACTIVITY_FRESHNESS_MS = 10 * 60_000;

/** Expiration is precomputed so WidgetKit can age observations while JS is suspended. */
export function agentActivityTimeline(props: AgentActivityProps, now: number) {
  const expiresAt = props.expiresAt;
  const expired: AgentActivityProps = {
    ...props,
    activeCount: null,
    isExpired: true,
    subtitle: "Open T3 to refresh",
    activities: props.activities.map((row) =>
      row.phase === "completed" || row.phase === "failed"
        ? row
        : { ...row, phase: "stale", status: "Out of date" },
    ),
  };
  if (expiresAt === undefined) return [{ date: new Date(now), props }];
  if (expiresAt <= now) return [{ date: new Date(now), props: expired }];
  return [
    { date: new Date(now), props },
    { date: new Date(expiresAt), props: expired },
  ];
}
