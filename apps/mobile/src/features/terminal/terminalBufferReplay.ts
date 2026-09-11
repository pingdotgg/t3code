import type { TerminalOutputUpdate } from "@t3tools/client-runtime/state/terminal";

export const TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS = 180;

export function getTerminalBufferReplayKey(input: {
  readonly terminalKey: string;
  readonly fontSize: number;
}): string {
  return `${input.terminalKey}:${input.fontSize}`;
}

export function isTerminalBufferReplayPaused(input: {
  readonly replayKey: string;
  readonly readyReplayKey: string | null;
}): boolean {
  return input.readyReplayKey !== null && input.readyReplayKey !== input.replayKey;
}

/** Native resets suppress replies; keep unread live bytes in separate write commands. */
export function nativeTerminalOutputCommands(update: TerminalOutputUpdate) {
  const commands: Array<{ type: "reset" | "write" | "writeReplay"; data: string }> = [];
  if (update.type === "none") return commands;
  if (update.type === "reset") commands.push({ type: "reset", data: "" });
  for (const segment of update.segments) {
    const previous = commands.at(-1);
    if (segment.delivery === "replay" && previous?.type === "reset") {
      previous.data += segment.data;
    } else {
      commands.push({
        type: segment.delivery === "replay" ? "writeReplay" : "write",
        data: segment.data,
      });
    }
  }
  return commands;
}
