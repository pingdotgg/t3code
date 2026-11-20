import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
import {
  carryProjectIcons,
  overviewMetrics,
  reconcileOverviewSnapshot,
} from "./pseudocode/overviewSnapshot";
import { overviewCopy } from "./pseudocode/overviewCopy";
import { widgetAppScheme } from "./pseudocode/widgetAppScheme";
import type { DirectWidgetUpdate } from "@t3tools/contracts";
import {
  EMPTY_AGENT_WIDGET_SNAPSHOT,
  mergeWidgetUpdate,
  type AgentWidgetSnapshot,
} from "./agentWidgetSnapshot";

let pending: Promise<unknown> = Promise.resolve();
function write<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
}

function propertyListSnapshot(snapshot: AgentWidgetSnapshot): AgentWidgetSnapshot {
  // WidgetKit persists the bridge payload in UserDefaults, which cannot store null values.
  return JSON.parse(
    JSON.stringify(snapshot, (_key, value: unknown) => value ?? undefined),
  ) as AgentWidgetSnapshot;
}

export function saveWidgetSnapshot(
  input: AgentWidgetSnapshot,
  liveEnvironments: readonly string[] = [],
) {
  const copy = {
    caughtUp: m(msg("All caught up. Start a task in PseudoCode.")),
    recent: m(msg("Recent results")),
    reviewError: m(msg("Open thread to review the error")),
    respond: m(msg("Tap to respond and keep work moving")),
    connectAgent: m(msg("Your tasks, at a glance. Open PseudoCode to connect.")),
    moreActive: m(msg("+{extra} more active", { extra: "{extra}" })),
    tapReview: m(msg("Tap to review")),
    tapOpen: m(msg("Tap to open")),
    needsAttention: m(msg("{attentionCount} need you", { attentionCount: "{attentionCount}" })),
    connectOverview: m(
      msg("Follow your work and see when your agent needs you. Open PseudoCode to connect."),
    ),
    delayed: m(msg("Updates delayed · Open to reconnect")),
    moreThreads: m(msg("+{value} more threads", { value: "{value}" })),
    workOverview: m(msg("Your work, at a glance")),
  };
  const { work, projectIcons, ...activity } = input;
  const snapshot = { ...activity, copy };
  return write(async () => {
    const { default: widget } = await import("./AgentWidget");
    widget.updateSnapshot(propertyListSnapshot(snapshot));
    const { default: overview } = await import("./pseudocode/OverviewWidget");
    const previous = (await overview.getTimeline()).at(0)?.props;
    updateOverview(
      overview,
      reconcileOverviewSnapshot(
        { ...snapshot, work, projectIcons, overviewText: overviewCopy() },
        previous,
        liveEnvironments,
      ),
      previous,
    );
  });
}
export type WidgetPushOutcome = "applied" | "seeded" | "unchanged";

/**
 * Applies a background push. A widget with no timeline yet (fresh install,
 * cleared state) is seeded from the push instead of waiting for the app to
 * open, so the push path never depends on a prior foreground write.
 */
export function saveWidgetPush(update: DirectWidgetUpdate): Promise<WidgetPushOutcome> {
  return write(async () => {
    const { default: widget } = await import("./AgentWidget");
    const timeline = await widget.getTimeline();
    const current = timeline.at(-1)?.props;
    const base = current ?? EMPTY_AGENT_WIDGET_SNAPSHOT;
    const next = mergeWidgetUpdate(base, update);
    if (next !== base) widget.updateSnapshot(propertyListSnapshot(next));
    const { default: overview } = await import("./pseudocode/OverviewWidget");
    const overviewCurrent = (await overview.getTimeline()).at(0)?.props ?? base;
    const overviewNext = mergeWidgetUpdate(overviewCurrent, update);
    if (overviewNext !== overviewCurrent) updateOverview(overview, overviewNext, overviewCurrent);
    return current === undefined ? "seeded" : next !== base ? "applied" : "unchanged";
  });
}

function updateOverview(
  widget: Pick<typeof import("./pseudocode/OverviewWidget").default, "updateTimeline">,
  snapshot: AgentWidgetSnapshot,
  previous: AgentWidgetSnapshot | undefined,
) {
  const now = new Date();
  const metrics = overviewMetrics(snapshot);
  const props = propertyListSnapshot({
    ...carryProjectIcons(snapshot, previous),
    ...metrics,
    appScheme: widgetAppScheme(),
    updatedAt: snapshot.updatedAt ?? now.toISOString(),
  });
  const deadline = metrics.overviewStaleAt;
  widget.updateTimeline(
    deadline !== undefined && deadline > now.getTime()
      ? [
          { date: now, props },
          { date: new Date(deadline), props },
        ]
      : [{ date: now, props }],
  );
}
