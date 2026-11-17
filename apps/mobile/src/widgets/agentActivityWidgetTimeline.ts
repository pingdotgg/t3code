import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { msg } from "gt-react-native";

import { m } from "../i18n/messages";

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
          ? m(msg("Sign in to {product} to see agents", { product: "T3 Connect" }))
          : source.kind === "unavailable"
            ? m(msg("Couldn't reach {product}", { product: "T3 Connect" }))
            : source.kind === "loading"
              ? m(msg("Loading agents…"))
              : m(msg("No active agents")),
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
        : { ...row, phase: "stale", status: m(msg("Out of date")) },
    ),
  };
  return [
    { date: new Date(now), props },
    { date: new Date(now + AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS), props: staleProps },
  ];
}
