import { compareSemverVersions, parseSemver } from "./semver.ts";
import { hashTelemetryId } from "./telemetryId.ts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import {
  activityPhasePriority,
  statusForPhase,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "./agentActivityAggregate.ts";
import { agentActivityExpiresAt, notificationForActivity } from "./agentActivityPayloads.ts";
import {
  alertForActivityRows,
  attentionTransitionRows,
  terminalTransitionRows,
  shouldAlertForActivity,
} from "./agentActivityAlerts.ts";

/**
 * Lets the device ignore pushes for an account it no longer has without FCM
 * seeing the account id. Builds before 2.4.0 only match the raw `user_id`.
 */
export function androidRecipientData(userId: string, deviceId: string, appVersion: string | null) {
  const readsHash =
    appVersion !== null &&
    parseSemver(appVersion) !== null &&
    compareSemverVersions(appVersion, "2.4.0") >= 0;
  return {
    device_id: deviceId,
    user_hash: hashTelemetryId(`${userId}:${deviceId}`),
    ...(readsHash ? {} : { user_id: userId }),
  };
}

export interface AndroidAgentAlert {
  readonly alert_id: string;
  readonly alert_group?: string;
  readonly alert_title: string;
  readonly alert_body: string;
  readonly alert_path: string;
}

export function androidAlertForState(
  state: RelayAgentActivityState,
  preferences: RelayAgentAwarenessPreferences,
  nowMs: number,
): AndroidAgentAlert | null {
  if (!shouldAlertForActivity({ ...state, preferences, nowMs })) return null;
  const notification = notificationForActivity({ ...state, status: statusForPhase(state.phase) });
  return {
    alert_id: JSON.stringify([state.environmentId, state.threadId, state.phase, state.updatedAt]),
    alert_group: JSON.stringify([state.environmentId, state.threadId]),
    alert_title: notification.title,
    alert_body: notification.body,
    alert_path: notification.deepLink,
  };
}

export function androidAlertForAggregate(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly nowMs: number;
}): AndroidAgentAlert | null {
  if (!input.preferences.notificationsEnabled) return null;
  const attention = attentionTransitionRows(input);
  const activities =
    attention.length > 0
      ? attention
      : terminalTransitionRows({ ...input, includeUnobserved: true });
  const first = activities[0];
  const alert = alertForActivityRows(activities);
  if (!first || !alert) return null;
  if (activities.length === 1) {
    const notification = notificationForActivity(first);
    return {
      alert_id: JSON.stringify([first.environmentId, first.threadId, first.phase, first.updatedAt]),
      alert_group: JSON.stringify([first.environmentId, first.threadId]),
      alert_title: notification.title,
      alert_body: notification.body,
      alert_path: notification.deepLink,
    };
  }
  return {
    // Stable across queue ordering and retries; the native receiver deduplicates it.
    alert_id: JSON.stringify(
      activities
        .map((row) => [row.environmentId, row.threadId, row.phase, row.updatedAt])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ),
    alert_title: alert.title,
    alert_body: alert.body,
    alert_path: "/",
  };
}

/** Android focuses the priority thread while retaining rows for older clients. */
export function androidActivityData(
  aggregate: RelayAgentActivityAggregateState | null,
): Record<string, string> {
  const rows = [...(aggregate?.activities ?? [])].sort(
    (a, b) => activityPhasePriority(a.phase) - activityPhasePriority(b.phase),
  );
  const activeCount = aggregate?.activeCount ?? 0;
  const attentionCount = rows.filter((row) => activityPhasePriority(row.phase) === 0).length;
  const failed = rows.some((row) => row.phase === "failed");
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const lines = rows.map((row) =>
    [row.status, clean(row.threadTitle), clean(row.projectTitle)].join("\t"),
  );
  const hero = rows[0];
  const title =
    activeCount > 0
      ? `${activeCount} active agent${activeCount === 1 ? "" : "s"}${attentionCount ? ` · ${attentionCount} need${attentionCount === 1 ? "s" : ""} attention` : ""}`
      : failed
        ? "Agent work failed"
        : "Agent work completed";
  const expiresAt = Math.max(
    0,
    ...rows.map((row) =>
      row.phase === "completed" || row.phase === "failed"
        ? Date.parse(row.updatedAt) + TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS
        : agentActivityExpiresAt(row),
    ),
  );
  return {
    active: String(activeCount > 0),
    activity_chip: activeCount > 0 ? (attentionCount > 0 ? "Review" : "Active") : "",
    activity_title: title,
    activity_phase: hero?.phase ?? "",
    activity_active_count: String(activeCount),
    activity_attention_count: String(attentionCount),
    activity_body: hero
      ? `${hero.status}: ${clean(hero.threadTitle)} · ${clean(hero.projectTitle)}`
      : "",
    ...Object.fromEntries(lines.map((line, index) => [`activity_line_${index}`, line])),
    activity_path: rows[0]?.deepLink ?? "/",
    activity_expires_at: String(expiresAt),
  };
}

/** Keep Unicode, escaping and grouped alerts within FCM's 4 KB data budget. */
export function fitFcmData(
  input: Readonly<Record<string, string>>,
  maxBytes = 3800,
): Record<string, string> {
  const data = { ...input };
  const encoder = new TextEncoder();
  const textKeys = Object.keys(data).filter(
    (key) => key.endsWith("_body") || key.endsWith("_title") || key.startsWith("activity_line_"),
  );
  while (encoder.encode(JSON.stringify(data)).length > maxBytes) {
    const key = textKeys.sort(
      (a, b) => encoder.encode(data[b]!).length - encoder.encode(data[a]!).length,
    )[0];
    if (!key) break;
    if (data[key]!.length <= 8) {
      textKeys.splice(textKeys.indexOf(key), 1);
      continue;
    }
    const parts = key.startsWith("activity_line_") ? data[key]!.split("\t") : [data[key]!];
    const part = parts.length === 3 ? (parts[1]!.length > parts[2]!.length ? 1 : 2) : 0;
    const characters = Array.from(parts[part]!);
    // Five characters would become four plus the ellipsis and never shrink.
    if (characters.length <= 5) {
      textKeys.splice(textKeys.indexOf(key), 1);
      continue;
    }
    parts[part] =
      characters
        .slice(0, Math.floor(characters.length * 0.8))
        .join("")
        .trimEnd() + "…";
    data[key] = parts.join("\t");
  }
  return data;
}
