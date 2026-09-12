import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import {
  activityPhasePriority,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "./agentActivityAggregate.ts";
import { agentActivityExpiresAt } from "./agentActivityPayloads.ts";

export function androidActivityHero(aggregate: RelayAgentActivityAggregateState) {
  return [...aggregate.activities].sort(
    (a, b) => activityPhasePriority(a.phase) - activityPhasePriority(b.phase),
  )[0];
}

/** The expanded Android card uses the same rows and priority as the iOS widget. */
export function androidActivityData(aggregate: RelayAgentActivityAggregateState | null) {
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
    activity_title: title,
    activity_body: hero
      ? `${hero.status}: ${clean(hero.threadTitle)} · ${clean(hero.projectTitle)}`
      : "",
    // Separate keys avoid double JSON encoding and preserve each expanded row when bounding the payload.
    ...Object.fromEntries(lines.map((line, index) => [`activity_line_${index}`, line])),
    activity_path: rows[0]?.deepLink ?? "/",
    activity_expires_at: String(expiresAt),
  };
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
