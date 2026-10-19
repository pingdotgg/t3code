import { terminalDebugLog } from "./terminalDebugLog";

export const TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS = 180;

export function getTerminalBufferReplayKey(input: {
  readonly terminalKey: string;
  readonly fontSize: number;
}): string {
  return `${input.terminalKey}:${input.fontSize}`;
}

export function getTerminalSurfaceReplayBuffer(input: {
  readonly buffer: string;
  readonly replayKey: string;
  readonly readyReplayKey: string | null;
}): string {
  if (input.readyReplayKey !== null && input.readyReplayKey !== input.replayKey) {
    terminalDebugLog("replay:stale-key-hiding-buffer", {
      replayKey: input.replayKey,
      readyReplayKey: input.readyReplayKey,
      bufferLen: input.buffer.length,
    });
    return "";
  }

  return input.buffer;
}
