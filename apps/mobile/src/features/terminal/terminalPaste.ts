import {
  chunkTerminalWrite,
  terminalWritePhase,
  type TerminalWriteInput,
} from "@t3tools/contracts";

import { encodeTerminalPaste } from "./terminalInput";

type WriteChunk = (data: string, phase?: TerminalWriteInput["plainWrite"]) => Promise<boolean>;

interface TerminalPasteInput {
  readonly readText: () => Promise<string>;
  readonly write: WriteChunk;
  readonly onReadError: (cause: unknown) => void;
}

export interface TerminalPasteSession {
  readonly reset: (active: boolean) => void;
  /** True until the terminal's liveness changes (stop, start or restart) after this call. */
  readonly liveness: () => () => boolean;
  readonly write: (data: string, send: WriteChunk) => Promise<void>;
  readonly paste: (input: TerminalPasteInput) => Promise<void>;
}

export function createTerminalPasteSession(): TerminalPasteSession {
  let liveTarget: object | null = null;
  let latestRequest = 0;
  let writeTail: Promise<void> | null = null;

  const writeChunks = (
    data: string,
    send: WriteChunk,
    isCurrent: () => boolean,
    queueSingle: boolean,
  ) => {
    const chunks = chunkTerminalWrite(data);
    const run = async () => {
      let started = false;
      try {
        for (const [index, chunk] of chunks.entries()) {
          if (!isCurrent()) return;
          const phase = terminalWritePhase(index, chunks.length);
          started ||= phase === "start";
          if (!(await send(chunk, phase))) return;
        }
        started = false;
      } finally {
        if (started) await send("", "abort");
      }
    };
    if (writeTail === null && !queueSingle && chunks.length <= 1) return run();
    const pending = (writeTail ?? Promise.resolve()).then(run, run);
    writeTail = pending;
    const clear = () => {
      if (writeTail === pending) writeTail = null;
    };
    void pending.then(clear, clear);
    return pending;
  };

  return {
    reset(active) {
      liveTarget = active ? {} : null;
    },

    liveness() {
      const target = liveTarget;
      return () => liveTarget === target;
    },

    async write(data, send) {
      // Input can arrive before the first attach snapshot sets liveness; the caller gates on running.
      const target = liveTarget;
      await writeChunks(data, send, () => liveTarget === target, false);
    },

    async paste({ readText, write, onReadError }) {
      const target = liveTarget;
      if (target === null) {
        return;
      }
      const request = ++latestRequest;
      const isCurrent = () => liveTarget === target && latestRequest === request;

      let text: string;
      try {
        text = await readText();
      } catch (cause) {
        onReadError(cause);
        return;
      }

      if (!isCurrent()) {
        return;
      }

      await writeChunks(encodeTerminalPaste(text), write, isCurrent, true);
    },
  };
}
