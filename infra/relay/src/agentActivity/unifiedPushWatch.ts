import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

import { makeAggregateState, statusForPhase } from "./agentActivityAggregate.ts";
import {
  androidActivityData,
  androidAlertForState,
  androidRecipientData,
  fitFcmData,
} from "./fcmPayloads.ts";

const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

type Alert = NonNullable<ReturnType<typeof androidAlertForState>>;

export function makeUnifiedPushWatch(identity: {
  readonly deviceId: string;
  readonly userId: string;
  /** Names the sender; the phone keeps one card per source. */
  readonly source?: string;
}) {
  const servers = new Map<string, Map<string, RelayAgentActivityState>>();
  const rejectedAlerts = new Map<string, string>();
  let previouslyActive = false;
  let lastCard: string | undefined;

  const message = (nowMs: number, alert: Alert | null, label: (active: boolean) => string) => {
    const aggregate = makeAggregateState({
      activeStates: [...servers.values()].flatMap((states) => [...states.values()]),
      terminalState: null,
      nowMs,
    });
    const activity = androidActivityData(aggregate);
    const active = activity.active === "true";
    const card = JSON.stringify(activity);
    const unchanged = card === lastCard;
    // A fresh watch always sends its first card, so the phone drops any stale one it holds.
    const first = lastCard === undefined;
    lastCard = card;
    if (!alert && !first && (unchanged || (!active && !previouslyActive))) return null;
    previouslyActive = active;
    return {
      label: label(active),
      data: fitFcmData({
        t3_kind: "agent_activity",
        // No app version keeps user_id, which AgentUnifiedPush matches before the shared receiver checks user_hash.
        ...androidRecipientData(identity.userId, identity.deviceId, null),
        ...(identity.source === undefined ? {} : { source: identity.source }),
        updated_at: String(nowMs),
        ...activity,
        ...alert,
      }),
    };
  };

  const activityLabel = (server: string) => (active: boolean) =>
    `${active ? "active" : "ended"} (${server})`;

  return {
    applySnapshot: (
      server: string,
      states: ReadonlyArray<RelayAgentActivityState>,
      nowMs: number,
    ) => {
      servers.set(server, new Map(states.map((state) => [state.threadId, state])));
      return message(nowMs, null, activityLabel(server));
    },
    applyThreadUpdate: (
      server: string,
      threadId: string,
      state: RelayAgentActivityState | null,
      nowMs: number,
    ) => {
      const states = servers.get(server) ?? new Map<string, RelayAgentActivityState>();
      servers.set(server, states);
      const previous = states.get(threadId);
      if (state) states.set(threadId, state);
      else states.delete(threadId);
      const alert =
        state && state.phase !== previous?.phase
          ? androidAlertForState(state, preferences, nowMs)
          : null;
      return message(
        nowMs,
        alert,
        state
          ? () => `${statusForPhase(state.phase).toLowerCase()} (${server})`
          : activityLabel(server),
      );
    },
    serverRejected: (server: string, nowMs: number) => {
      if (rejectedAlerts.has(server)) return null;
      const alertId = JSON.stringify(["unifiedpush-health", server, nowMs]);
      rejectedAlerts.set(server, alertId);
      // The phone repaints the card from every message, so health alerts carry the activity too.
      return message(
        nowMs,
        {
          alert_id: alertId,
          alert_group: "t3-unifiedpush-health",
          alert_title: `T3 push watcher cannot reach ${server}`,
          alert_body: `${server} rejected the watcher's credentials. Pair the watcher again and update its config.`,
          alert_path: "/",
        },
        () => `health (${server})`,
      );
    },
    serverConnected: (server: string) => {
      rejectedAlerts.delete(server);
    },
  };
}
