import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";

/** Marks a typed message whose reply is read aloud, as Pi's voice mode does. */
export function markSpokenReply(text: string, voiceOn: boolean): string {
  if (!voiceOn || text.trimStart().startsWith("/") || /^(🔊|🎙)/u.test(text)) return text;
  return `🔊  ${text}`;
}

interface Reply {
  readonly runId: RunId;
  readonly text: string;
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
  if (run === null) return null;
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
    ? { runId: run.id, text: text.text }
    : null;
}
