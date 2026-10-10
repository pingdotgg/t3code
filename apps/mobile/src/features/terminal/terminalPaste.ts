import { chunkTerminalWrite, encodeTerminalPaste } from "./terminalInput";

interface TerminalPasteInput {
  readonly readText: () => Promise<string>;
  readonly write: (data: string) => Promise<boolean>;
  readonly onReadError: (cause: unknown) => void;
}

export interface TerminalPasteSession {
  readonly reset: (active: boolean) => void;
  readonly paste: (input: TerminalPasteInput) => Promise<void>;
}

/** Coordinates clipboard reads and writes for the currently attached pty. */
export function createTerminalPasteSession(): TerminalPasteSession {
  let liveTarget: object | null = null;
  let latestRequest = 0;
  let writeTail: Promise<void> = Promise.resolve();

  return {
    reset(active) {
      liveTarget = active ? {} : null;
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

      const writePaste = async () => {
        for (const chunk of chunkTerminalWrite(encodeTerminalPaste(text))) {
          if (!isCurrent() || !(await write(chunk))) {
            return;
          }
        }
      };
      const queuedWrite = writeTail.then(writePaste, writePaste);
      writeTail = queuedWrite.then(
        () => undefined,
        () => undefined,
      );
      await queuedWrite;
    },
  };
}
