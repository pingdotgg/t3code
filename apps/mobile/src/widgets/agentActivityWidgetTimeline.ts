import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";

import type { AgentActivityPhase, AgentActivityProps, AgentActivityText } from "./AgentActivity";

// The widget only refreshes while the app is open, so after this long it stops
// claiming an agent is still working. Matches the Live Activity's stale date.
export const AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS = 10 * 60_000;

export type AgentActivityWidgetSource =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "snapshot"; readonly aggregate: RelayAgentActivityAggregateState | null };

function countTable(maxCount: number, format: (count: number) => string) {
  return Object.fromEntries(
    Array.from({ length: maxCount }, (_, index) => [String(index + 1), format(index + 1)]),
  );
}

/** Translated widget copy, with count tables for counts up to `maxCount`. */
export function agentActivityText(
  maxCount: number,
  resolve: MessageResolver = m,
): AgentActivityText {
  return {
    outOfDate: resolve(msg("Out of date")),
    failed: resolve(msg("Failed", { $context: "agent work status" })),
    done: resolve(msg("Done", { $context: "agent work status" })),
    workFailed: resolve(msg("Agent work failed")),
    workCompleted: resolve(msg("Agent work completed")),
    statusOutOfDate: resolve(msg("Agent status out of date")),
    approval: resolve(msg("Approval", { $context: "agent waits for an approval" })),
    input: resolve(msg("Input", { $context: "agent waits for user input" })),
    noActiveAgents: resolve(msg("No active agents")),
    activeAgents: countTable(maxCount, (count) =>
      resolve(
        msg("{count, plural, one {{count} active agent} other {{count} active agents}}", {
          count,
        }),
      ),
    ),
    active: countTable(maxCount, (count) =>
      resolve(
        msg("{count, plural, one {{count} active} other {{count} active}}", {
          count,
          $context: "number of agents working",
        }),
      ),
    ),
    needAttention: countTable(maxCount, (count) =>
      resolve(
        msg("{count, plural, one {{count} needs attention} other {{count} need attention}}", {
          count,
        }),
      ),
    ),
    needYou: countTable(maxCount, (count) =>
      resolve(msg("{count, plural, one {{count} needs you} other {{count} need you}}", { count })),
    ),
  };
}

/** The relay's snapshot statuses are English; the widget shows the app's language instead. */
function agentActivityStatus(phase: AgentActivityPhase, resolve: MessageResolver): string {
  switch (phase) {
    case "starting":
      return resolve(msg("Connecting", { $context: "agent status" }));
    case "running":
      return resolve(msg("Working", { $context: "agent status" }));
    case "waiting_for_approval":
      return resolve(msg("Approval", { $context: "agent waits for an approval" }));
    case "waiting_for_input":
      return resolve(msg("Input", { $context: "agent waits for user input" }));
    case "completed":
      return resolve(msg("Done", { $context: "agent work status" }));
    case "failed":
      return resolve(msg("Failed", { $context: "agent work status" }));
    case "stale":
      return resolve(msg("Waiting", { $context: "agent status" }));
  }
}

/** Card and widget props for a relay snapshot, in the app's language. */
export function agentActivityProps(
  aggregate: RelayAgentActivityAggregateState,
  resolve: MessageResolver = m,
): AgentActivityProps {
  return {
    text: agentActivityText(Math.max(aggregate.activeCount, aggregate.activities.length), resolve),
    title: aggregate.title,
    subtitle:
      aggregate.activeCount > 0
        ? resolve(msg("Agent work in progress"))
        : aggregate.activities[0]?.phase === "failed"
          ? resolve(msg("Agent work failed"))
          : resolve(msg("Agent work completed")),
    activeCount: aggregate.activeCount,
    updatedAt: aggregate.updatedAt,
    activities: aggregate.activities.map((row) => ({
      ...row,
      status: agentActivityStatus(row.phase, resolve),
    })),
  };
}

export function agentActivityWidgetTimeline(
  source: AgentActivityWidgetSource,
  now: number,
  resolve: MessageResolver = m,
) {
  const updatedAt = new Date(now).toISOString();
  if (source.kind !== "snapshot" || !source.aggregate) {
    const props: AgentActivityProps = {
      text: agentActivityText(0, resolve),
      title: "T3 Code",
      subtitle:
        source.kind === "signed-out"
          ? resolve(msg("Sign in to {product} to see agents", { product: "T3 Connect" }))
          : source.kind === "unavailable"
            ? resolve(msg("Couldn't reach {product}", { product: "T3 Connect" }))
            : source.kind === "loading"
              ? resolve(msg("Loading agents…"))
              : resolve(msg("No active agents")),
      activeCount: 0,
      updatedAt,
      activities: [],
    };
    return [{ date: new Date(now), props }];
  }

  const props = agentActivityProps(source.aggregate, resolve);
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
        : { ...row, phase: "stale", status: resolve(msg("Out of date")) },
    ),
  };
  return [
    { date: new Date(now), props },
    { date: new Date(now + AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS), props: staleProps },
  ];
}
