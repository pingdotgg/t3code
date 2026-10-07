// Shared by the server and the plugin child, which loads without the Effect
// runtime: keep this module free of imports.

/** File descriptor of the newline-delimited JSON channel inside the child. */
export const PLUGIN_IPC_FD = 3;

/** Default upper bound for one encoded IPC message, newline excluded. */
export const DEFAULT_PLUGIN_IPC_MAX_BYTES = 1024 * 1024;

/** Largest per-message bound the server may be configured with. */
export const PLUGIN_IPC_MAX_BYTES_LIMIT = 16 * 1024 * 1024;

/**
 * Bounds the bytes of complete lines a reader holds before handling them.
 * `hold` pauses the source once `maxBytes` are held; `release` resumes it
 * when the backlog falls below half. The source may deliver one more chunk
 * after pausing, so the backlog stays under `maxBytes` plus one chunk.
 */
export const makeReadBudget = (input: {
  readonly maxBytes: number;
  readonly pause: () => void;
  readonly resume: () => void;
}) => {
  let held = 0;
  let paused = false;
  return {
    hold: (bytes: number): void => {
      held += bytes;
      if (!paused && held >= input.maxBytes) {
        paused = true;
        input.pause();
      }
    },
    release: (bytes: number): void => {
      held -= bytes;
      if (paused && held < input.maxBytes / 2) {
        paused = false;
        input.resume();
      }
    },
  };
};

/**
 * Splits a byte stream into UTF-8 lines and refuses to buffer more than
 * `maxBytes` for one line, so a peer cannot make the reader hold an unbounded
 * message in memory. After an overflow it stops delivering lines.
 */
export const makeLineDecoder = (input: {
  readonly maxBytes: number;
  /** Receives each line with its size in bytes. */
  readonly onLine: (line: string, bytes: number) => void;
  readonly onOverflow: () => void;
}) => {
  let parts: Array<Buffer> = [];
  let buffered = 0;
  let overflowed = false;
  return (chunk: Buffer): void => {
    let start = 0;
    while (!overflowed) {
      const newline = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      if (buffered + piece.length > input.maxBytes) {
        overflowed = true;
        parts = [];
        input.onOverflow();
        return;
      }
      if (newline === -1) {
        if (piece.length > 0) {
          parts.push(piece);
          buffered += piece.length;
        }
        return;
      }
      const bytes = buffered + piece.length;
      const line = (parts.length === 0 ? piece : Buffer.concat([...parts, piece])).toString("utf8");
      parts = [];
      buffered = 0;
      start = newline + 1;
      input.onLine(line, bytes);
    }
  };
};
