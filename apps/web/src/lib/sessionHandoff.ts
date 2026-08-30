const HANDOFF_OPEN = "<!-- t3-handoff:1 -->";
const HANDOFF_CLOSE = "<!-- /t3-handoff -->";

export interface SessionHandoff {
  readonly packet: string;
  readonly nextTask: string;
  readonly title: string;
}

function titleFromNextTask(nextTask: string): string {
  const firstLine = nextTask
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .find((line) => line.length > 0);
  const title = firstLine ?? "Continue previous task";
  return title.length <= 72 ? title : `${title.slice(0, 69).trimEnd()}...`;
}

export function parseSessionHandoff(text: string | null): SessionHandoff | null {
  if (text === null) return null;
  const openAt = text.indexOf(HANDOFF_OPEN);
  if (openAt < 0) return null;
  const packetStart = openAt + HANDOFF_OPEN.length;
  const closeAt = text.indexOf(HANDOFF_CLOSE, packetStart);
  if (closeAt < 0) return null;

  const packet = text.slice(packetStart, closeAt).trim();
  const nextTaskMatch = packet.match(
    /(?:^|\n)## Next task\s*\n([\s\S]*?)(?=\n## [^\n]+\s*(?:\n|$)|$)/,
  );
  const nextTask = nextTaskMatch?.[1]?.trim() ?? "";
  if (packet.length === 0 || nextTask.length === 0) return null;

  return { packet, nextTask, title: titleFromNextTask(nextTask) };
}

export function buildSessionHandoffPrompt(input: {
  readonly handoff: SessionHandoff;
  readonly sourceEnvironmentId: string;
  readonly sourceThreadId: string;
}): string {
  const sourcePath = `/${encodeURIComponent(input.sourceEnvironmentId)}/${encodeURIComponent(input.sourceThreadId)}`;
  return [
    `Continue this work from the [previous thread](${sourcePath}).`,
    "Treat the handoff as task context, then complete its Next task.",
    "",
    input.handoff.packet,
  ].join("\n");
}
