import type { OrchestrationV2ThreadProjection, RunId, VoiceMode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Marks a typed message whose reply is read aloud, as Pi's voice mode does. */
export function markSpokenReply(text: string, voiceOn: boolean): string {
  if (!voiceOn || text.trimStart().startsWith("/") || /^(🔊|🎙)/u.test(text)) return text;
  return `🔊  ${text}`;
}

/** The voice button steps off, one-way, two-way, then off again. */
export function nextButtonVoiceMode(mode: VoiceMode): VoiceMode {
  return mode === "off" ? "oneWay" : mode === "oneWay" ? "twoWay" : "off";
}

/** The voice shortcut turns voice on one-way, then switches between one-way and two-way. */
export function nextShortcutVoiceMode(mode: VoiceMode): VoiceMode {
  return mode === "oneWay" ? "twoWay" : "oneWay";
}

interface Reply {
  readonly runId: RunId;
  readonly text: string;
  readonly completedAtMs: number;
}

/** The final answer of the thread's latest completed run. */
export function latestReply(projection: OrchestrationV2ThreadProjection): Reply | null {
  const run = projection.runs
    .filter((candidate) => candidate.status === "completed")
    .reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
      (latest, candidate) =>
        latest === null || candidate.ordinal > latest.ordinal ? candidate : latest,
      null,
    );
  if (run === null || run.completedAt === null) return null;
  const completedAtMs = DateTime.toEpochMillis(run.completedAt);
  const text = projection.turnItems
    .filter(
      (item) =>
        item.type === "assistant_message" &&
        item.runId === run.id &&
        item.parentItemId === null &&
        !item.streaming,
    )
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .at(-1);
  return text?.type === "assistant_message" && text.text.trim() !== ""
    ? { runId: run.id, text: text.text, completedAtMs }
    : null;
}
