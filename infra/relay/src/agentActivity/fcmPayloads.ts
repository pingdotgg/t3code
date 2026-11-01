import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import {
  activityPhasePriority,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "./agentActivityAggregate.ts";
import { agentActivityExpiresAt } from "./agentActivityPayloads.ts";

export function androidActivityData(
  aggregate: RelayAgentActivityAggregateState | null,
  nowMs = Date.parse(aggregate?.updatedAt ?? ""),
  lifecycleStates?: ReadonlyArray<RelayAgentActivityState>,
) {
  const rows = [...(aggregate?.activities ?? [])].sort(
    (a, b) =>
      activityPhasePriority(a.phase, a.unread) - activityPhasePriority(b.phase, b.unread) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  const activeCount = aggregate?.activeCount ?? 0;
  const attentionCount =
    aggregate?.attentionCount ??
    rows.filter((row) => activityPhasePriority(row.phase) === 0).length;
  const workingCount = aggregate?.workingCount ?? Math.max(0, activeCount - attentionCount);
  const unreadCount = aggregate?.unreadCount ?? 0;
  const active = (aggregate?.pendingCount ?? activeCount) > 0;
  const failed = rows.some((row) => row.phase === "failed");
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const lines = rows.map((row) =>
    [
      row.phase === "completed" && row.unread === false
        ? elapsedLabel(nowMs - Date.parse(row.completedAt ?? row.updatedAt))
        : row.status,
      clean(row.threadTitle),
      clean(row.projectTitle),
    ].join("\t"),
  );
  const hero = rows[0];
  const title = active
    ? [
        workingCount ? `${workingCount} working` : "",
        attentionCount ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} attention` : "",
        unreadCount ? `${unreadCount} done` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : failed
      ? "Agent work failed"
      : "All caught up";
  const pendingResult = lifecycleStates?.some(
    (state) =>
      state.retained === true &&
      (state.phase === "woke" ||
        (state.unread !== false && (state.phase === "completed" || state.phase === "failed"))),
  );
  const expiresAt =
    aggregate?.pendingCount === 0 || pendingResult
      ? 0
      : Math.max(
          0,
          ...(lifecycleStates ?? rows).map((row) =>
            row.phase === "completed" || row.phase === "failed"
              ? "retained" in row && row.retained === true
                ? 0
                : Date.parse(row.updatedAt) + TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS
              : agentActivityExpiresAt(row),
          ),
        );
  return {
    active: String(active),
    activity_chip: active
      ? attentionCount > 0
        ? "Review"
        : unreadCount > 0
          ? "Done"
          : "Active"
      : "",
    activity_title: title,
    activity_phase: hero?.phase ?? "",
    activity_active_count: String(activeCount),
    activity_working_count: String(workingCount),
    ...(aggregate?.totalCount === undefined
      ? {}
      : { activity_total_count: String(aggregate.totalCount) }),
    activity_attention_count: String(attentionCount),
    activity_unread_count: String(aggregate?.unreadCount ?? 0),
    activity_body: hero
      ? `${hero.status}: ${clean(hero.threadTitle)} · ${clean(hero.projectTitle)}`
      : "",
    ...Object.fromEntries(lines.map((line, index) => [`activity_line_${index}`, line])),
    activity_path: rows[0]?.deepLink ?? "/",
    activity_expires_at: String(expiresAt),
  };
}

function elapsedLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "Read";
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1_440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1_440)}d`;
}

/** Keep Unicode, escaping and grouped alerts within FCM's 4 KB data budget. */
export function fitFcmData(input: Readonly<Record<string, string>>): Record<string, string> {
  const data = { ...input };
  const encoder = new TextEncoder();
  const textKeys = Object.keys(data).filter(
    (key) => key.endsWith("_body") || key.endsWith("_title") || key.startsWith("activity_line_"),
  );
  while (encoder.encode(JSON.stringify(data)).length > 3800) {
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
