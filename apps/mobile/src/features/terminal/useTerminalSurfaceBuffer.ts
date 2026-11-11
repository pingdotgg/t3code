import { useState } from "react";

/** A null buffer means the attachment is waiting for its first snapshot. */
export function useTerminalSurfaceBuffer({
  terminalKey,
  buffer,
}: {
  readonly terminalKey: string;
  readonly buffer: string | null;
}): string {
  const [snapshot, setSnapshot] = useState({ terminalKey, buffer: buffer ?? "" });
  const currentBuffer = buffer ?? (snapshot.terminalKey === terminalKey ? snapshot.buffer : "");
  if (snapshot.terminalKey !== terminalKey || snapshot.buffer !== currentBuffer) {
    setSnapshot({ terminalKey, buffer: currentBuffer });
  }
  return currentBuffer;
}
