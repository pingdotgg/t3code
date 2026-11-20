import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { selectWidgetActivities, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import type { DirectWidgetUpdate } from "@t3tools/contracts";

export function compactWidgetUpdate(input: DirectWidgetUpdate): DirectWidgetUpdate {
  const update = { ...input, activity: { ...input.activity } };
  while (Buffer.byteLength(JSON.stringify(update)) > 2800 && update.activity.activities.length) {
    update.activity.activities = update.activity.activities.slice(0, -1);
  }
  return update;
}

export function isActive(state: AgentAwarenessState) {
  return (
    state.phase === "starting" ||
    state.phase === "running" ||
    state.phase === "waiting_for_approval" ||
    state.phase === "waiting_for_input"
  );
}
export function activityIdentity(state: AgentAwarenessState | null) {
  if (!state) return "null";
  const { updatedAt: _updatedAt, ...rest } = state;
  return JSON.stringify(rest);
}
const truncate = (value: string) => [...value].slice(0, 60).join("");
export function aggregateActivity(
  states: Iterable<AgentAwarenessState>,
  now: string,
): RelayAgentActivityAggregateState {
  const selected = selectWidgetActivities(states, Date.parse(now));
  const active = selected.filter(isActive);
  return {
    title: "Agent activity",
    subtitle: active.length
      ? `${active.length} active agent${active.length === 1 ? "" : "s"}`
      : "All caught up",
    activeCount: active.length,
    updatedAt: now,
    activities: selected.slice(0, 5).map((state) => ({
      environmentId: state.environmentId,
      threadId: state.threadId,
      projectTitle: truncate(state.projectTitle),
      threadTitle: truncate(state.threadTitle),
      modelTitle: truncate(state.modelTitle),
      phase: state.phase,
      status: state.headline,
      ...(state.detail ? { detail: state.detail } : {}),
      ...(state.summary ? { summary: state.summary } : {}),
      ...(state.turnId ? { turnId: state.turnId } : {}),
      ...(state.projectId ? { projectId: state.projectId } : {}),
      updatedAt: state.updatedAt,
      deepLink: state.deepLink,
    })),
  };
}
/** Past the widget's delayed threshold, so one missed heartbeat does not read as stale. */
const LIVE_ACTIVITY_STALE_SECONDS = 25 * 60;
export function liveActivityPayload(
  state: RelayAgentActivityAggregateState,
  nowSeconds: number,
  end = false,
  name = "DirectAgentActivity",
  appScheme?: string,
) {
  // Only the fields apps/mobile AgentActivity reads; the widget-only extras would spend APNs bytes.
  const compact = {
    appScheme,
    title: state.title,
    subtitle: state.subtitle,
    activeCount: state.activeCount,
    updatedAt: state.updatedAt,
    activities: state.activities.map((row) => ({
      environmentId: row.environmentId,
      threadId: row.threadId,
      projectTitle: row.projectTitle,
      threadTitle: row.threadTitle,
      modelTitle: row.modelTitle,
      phase: row.phase,
      status: row.status,
      updatedAt: row.updatedAt,
      deepLink: row.deepLink,
    })),
  };
  const make = () => ({
    aps: {
      timestamp: nowSeconds,
      event: end ? "end" : "update",
      "content-state": { name, props: JSON.stringify(compact) },
      ...(end
        ? { "dismissal-date": nowSeconds + 30 }
        : { "stale-date": nowSeconds + LIVE_ACTIVITY_STALE_SECONDS }),
    },
  });
  // UTF-8 titles and nested JSON can exceed APNs' limit even at three rows.
  while (Buffer.byteLength(JSON.stringify(make())) > 4096 && compact.activities.length)
    compact.activities.pop();
  return make();
}
export function attentionPayload(state: AgentAwarenessState) {
  return {
    aps: {
      alert: {
        title: state.headline,
        body: `${truncate(state.projectTitle)} · ${truncate(state.threadTitle)}`,
      },
      sound: "default",
    },
    environmentId: state.environmentId,
    threadId: state.threadId,
    deepLink: state.deepLink,
  };
}
