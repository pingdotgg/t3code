import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";

import type { AgentActivityProps } from "./AgentActivity";

// The widget only refreshes while the app is open, so after this long it stops
// claiming an agent is still working. Matches the Live Activity's stale date.
export const AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS = 10 * 60_000;

export type AgentActivityWidgetSource =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "snapshot"; readonly aggregate: RelayAgentActivityAggregateState | null };

export function agentActivityWidgetTimeline(source: AgentActivityWidgetSource, now: number) {
  const updatedAt = new Date(now).toISOString();
  if (source.kind !== "snapshot" || !source.aggregate) {
    const props: AgentActivityProps = {
      title: "T3 Code",
      subtitle:
        source.kind === "signed-out"
          ? "Sign in to T3 Connect to see agents"
          : source.kind === "unavailable"
            ? "Couldn't reach T3 Connect"
            : source.kind === "loading"
              ? "Loading agents…"
              : "No active agents",
      activeCount: 0,
      updatedAt,
      activities: [],
    };
    return [{ date: new Date(now), props }];
  }

  const { aggregate } = source;
  const props: AgentActivityProps = {
    title: aggregate.title,
    subtitle: aggregate.subtitle,
    activeCount: aggregate.activeCount,
    updatedAt: aggregate.updatedAt,
    activities: aggregate.activities,
  };
  const hasInFlightRows = props.activities.some(
    (row) => row.phase !== "completed" && row.phase !== "failed",
  );
  if (!hasInFlightRows) {
    return [{ date: new Date(now), props }];
  }
  const staleProps: AgentActivityProps = {
    ...props,
    activities: props.activities.map((row) =>
      row.phase === "completed" || row.phase === "failed"
        ? row
        : { ...row, phase: "stale", status: "Out of date" },
    ),
  };
  return [
    { date: new Date(now), props },
    { date: new Date(now + AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS), props: staleProps },
  ];
}

export interface AgentActivityWidgetSnapshot extends AgentActivityProps {
  // Android has no timeline, so its layout swaps to these rows once `at` passes.
  readonly stale?: { readonly at: number; readonly activities: AgentActivityProps["activities"] };
}

export function agentActivityWidgetSnapshot(
  source: AgentActivityWidgetSource,
  now: number,
): AgentActivityWidgetSnapshot {
  const [current, stale] = agentActivityWidgetTimeline(source, now);
  const { activities } = current!.props;
  const priority = (index: number) => {
    const phase = activities[index]!.phase;
    if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
    if (phase === "failed") return 1;
    return phase === "running" || phase === "starting" ? 2 : 3;
  };
  // Threads that need the user come first, then failures, then running work.
  // The stale rows keep that order so nothing moves when they go out of date.
  const order = activities.map((_, index) => index).sort((a, b) => priority(a) - priority(b));
  const ordered = (rows: AgentActivityProps["activities"]) => order.map((index) => rows[index]!);
  return {
    ...current!.props,
    activities: ordered(activities),
    ...(stale
      ? { stale: { at: stale.date.getTime(), activities: ordered(stale.props.activities) } }
      : {}),
  };
}
