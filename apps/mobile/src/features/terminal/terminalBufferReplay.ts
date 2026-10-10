import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { terminalDebugLog } from "./terminalDebugLog";

export const TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS = 180;

export function getTerminalBufferReplayKey(input: {
  readonly terminalKey: string;
  readonly fontSize: number;
}): string {
  return `${input.terminalKey}:${input.fontSize}`;
}

export function getTerminalSurfaceReplayBuffer(input: {
  readonly buffer: TerminalOutputState;
  readonly replayKey: string;
  readonly readyReplayKey: string | null;
}): TerminalOutputState {
  // Pass live buffer whenever ready key is unset or matches. Only return "" when ready key is
  // stale vs current replay key (e.g. mid font-size transition).
  if (input.readyReplayKey !== null && input.readyReplayKey !== input.replayKey) {
    terminalDebugLog("replay:stale-key-hiding-buffer", {
      replayKey: input.replayKey,
      readyReplayKey: input.readyReplayKey,
      bufferLen: input.buffer.retainedBytes,
    });
    return EMPTY_TERMINAL_BUFFER_STATE.output;
  }

  return input.buffer;
}
