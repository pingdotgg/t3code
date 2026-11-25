import { chunkTerminalWrite } from "@t3tools/contracts";

/** Sends one chunk of terminal input; resolves false when it failed and the rest should drop. */
type SendTerminalChunk = (chunk: string) => Promise<boolean | "not-dispatched">;

/**
 * Orders one terminal's input into writes that fit `terminal.write`. A split write goes one chunk
 * per round trip and later input waits behind it; other writes go out immediately, like keystrokes.
 */
export function createTerminalInputWriter(onIdle = () => {}) {
  let pending: Promise<void> | null = null;
  const immediate = new Set<Promise<void>>();

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
    interrupted: () => void,
  ) => {
    if (closeInterruptedPaste !== null && !(await closePaste())) {
      interrupted();
      return;
    }
    const bracketed =
      chunks.length > 1 && data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~");
    let opened = false;
    try {
      for (const chunk of chunks) {
        const result = await send(chunk);
        if (result !== true) {
          if (result !== "not-dispatched") opened = bracketed;
          if (chunks.length > 1) interrupted();
          return;
        }
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
    recover: () => Promise<boolean> = async () => (await send("\x1b[201~")) === true,
    interrupted = () => {},
  ): Promise<void> => {
    const idle = () => {
      if (pending === null && immediate.size === 0 && closeInterruptedPaste === null) onIdle();
    };
    const chunks = chunkTerminalWrite(data);
    const run = () => sendChunks(data, chunks, send, recover, interrupted);
    if (pending === null && closeInterruptedPaste === null && chunks.length === 1) {
      const current = run();
      immediate.add(current);
      void current.then(
        () => {
          immediate.delete(current);
          idle();
        },
        () => {
          immediate.delete(current);
          idle();
        },
      );
      return current;
    }
    const previous = pending ?? (immediate.size > 0 ? Promise.allSettled(immediate) : null);
    const current = previous === null ? run() : previous.then(run, run);
    pending = current;
    const reset = () => {
      if (pending === current) pending = null;
      idle();
    };
    void current.then(reset, reset);
    return current;
  };
}

const writers = new Map<string, ReturnType<typeof createTerminalInputWriter>>();

/** Retain ordering and framing obligations until acknowledged, across terminal view remounts. */
export function terminalInputWriter(key: string) {
  const existing = writers.get(key);
  if (existing) return existing;
  const writer = createTerminalInputWriter(() => {
    if (writers.get(key) === writer) writers.delete(key);
  });
  writers.set(key, writer);
  return writer;
}
