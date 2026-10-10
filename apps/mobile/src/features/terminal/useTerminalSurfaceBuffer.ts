import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { useState } from "react";

/** A null buffer means the attachment is waiting for its first snapshot. */
export function useTerminalSurfaceBuffer({
  terminalKey,
  buffer,
}: {
  readonly terminalKey: string;
  readonly buffer: TerminalOutputState | null;
}): TerminalOutputState {
  const [snapshot, setSnapshot] = useState({
    terminalKey,
    buffer: buffer ?? EMPTY_TERMINAL_BUFFER_STATE.output,
  });
  const currentBuffer =
    buffer ??
    (snapshot.terminalKey === terminalKey ? snapshot.buffer : EMPTY_TERMINAL_BUFFER_STATE.output);
  if (snapshot.terminalKey !== terminalKey || snapshot.buffer !== currentBuffer) {
    setSnapshot({ terminalKey, buffer: currentBuffer });
  }
  return currentBuffer;
}
