import { chunkTerminalWrite } from "@t3tools/contracts";

/** Sends one chunk of terminal input; resolves false when it failed and the rest should drop. */
type SendTerminalChunk = (chunk: string) => Promise<boolean>;

/**
 * Orders one terminal's input into writes that fit `terminal.write`. A split write goes one chunk
 * per round trip and later input waits behind it; small writes use a bounded immediate window.
 */
export function createTerminalInputWriter() {
  let pending: Promise<void> | null = null;
  // Allow typing ahead of acknowledgements without letting stalled RPCs grow without bound.
  const immediate = new Set<Promise<void>>();
  const maxImmediateWrites = 8;

  let closeInterruptedPaste: (() => Promise<boolean>) | null = null;
  const closePaste = async () => {
    if (closeInterruptedPaste === null) return true;
    if (!(await closeInterruptedPaste())) return false;
    closeInterruptedPaste = null;
    return true;
  };

  const sendChunks = async (
    data: string,
    chunks: ReadonlyArray<string>,
    send: SendTerminalChunk,
    recover: () => Promise<boolean>,
  ) => {
    if (closeInterruptedPaste !== null && !(await closePaste())) return;
    const bracketed =
      chunks.length > 1 && data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~");
    let opened = false;
    try {
      for (const chunk of chunks) {
        if (!(await send(chunk))) return;
        opened = bracketed;
      }
      opened = false;
    } finally {
      if (opened) {
        closeInterruptedPaste = recover;
        await closePaste();
      }
    }
  };

  return (
    data: string,
    send: SendTerminalChunk,
    recover = () => send("\x1b[201~"),
  ): Promise<void> => {
    const chunks = chunkTerminalWrite(data);
    const run = () => sendChunks(data, chunks, send, recover);
    if (
      pending === null &&
      closeInterruptedPaste === null &&
      chunks.length === 1 &&
      immediate.size < maxImmediateWrites
    ) {
      const current = run();
      immediate.add(current);
      void current.then(
        () => immediate.delete(current),
        () => immediate.delete(current),
      );
      return current;
    }
    const previous = pending ?? (immediate.size > 0 ? Promise.allSettled(immediate) : null);
    const current = previous === null ? run() : previous.then(run, run);
    pending = current;
    const reset = () => {
      if (pending === current) pending = null;
    };
    void current.then(reset, reset);
    return current;
  };
}
