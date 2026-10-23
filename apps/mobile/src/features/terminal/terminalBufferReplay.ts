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
    return "";
  }

  return input.buffer;
}
