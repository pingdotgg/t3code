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
  let writeTail: Promise<void> = Promise.resolve();

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
    if (!queueSingle && chunks.length <= 1) return run();
    const pending = writeTail.then(run, run);
    writeTail = pending.then(
      () => undefined,
      () => undefined,
    );
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
      const target = liveTarget;
      if (target !== null) await writeChunks(data, send, () => liveTarget === target, false);
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
