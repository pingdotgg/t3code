// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
// Owner-only named pipes between the server and the agent's shell commands. A one-read pipe hands
// a command a secret; a show pipe takes values a command writes for the user. Values stay in this
// process's memory and are never written to disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

/** Windows has no FIFOs, so `file` delivery is refused there. */
export const pipesSupportedOn = (platform: string) => platform !== "win32";

/** Makes an owner-only FIFO at `path`. Fails if anything is already there. */
export const createPipe = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile("mkfifo", ["-m", "600", "--", path], (error) =>
      error ? reject(error) : resolve(),
    );
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/**
 * Waits for a reader to open the pipe at `path`, writes `value` to it once, then removes
 * the pipe and zeroes `value`. Resolves true when a reader got the value, false when
 * `windowMs` passed, the signal aborted, or the pipe was removed first.
 */
export async function servePipeOnce(
  path: string,
  value: Uint8Array,
  options: { readonly windowMs: number; readonly signal?: AbortSignal; readonly pollMs?: number },
): Promise<boolean> {
  const pollMs = options.pollMs ?? 100;
  const until = Date.now() + options.windowMs;
  const stopped = () => Date.now() >= until || options.signal?.aborted === true;
  const { O_WRONLY, O_NONBLOCK, O_NOFOLLOW } = NodeFS.constants;
  try {
    while (!stopped()) {
      let fd: number;
      try {
        // Non-blocking: without a reader this fails at once with ENXIO instead of hanging.
        fd = NodeFS.openSync(path, O_WRONLY | O_NONBLOCK | O_NOFOLLOW);
      } catch (error) {
        if (errorCode(error) === "ENXIO") {
          await sleep(pollMs);
          continue;
        }
        return false;
      }
      try {
        if (!NodeFS.fstatSync(fd).isFIFO()) return false;
        let offset = 0;
        while (offset < value.length) {
          try {
            offset += NodeFS.writeSync(fd, value, offset);
          } catch (error) {
            // A full pipe buffer: wait for the reader to drain it.
            if (errorCode(error) !== "EAGAIN") throw error;
            if (stopped()) return false;
            await sleep(10);
          }
        }
        return true;
      } finally {
        NodeFS.closeSync(fd);
      }
    }
    return false;
  } finally {
    value.fill(0);
    NodeFS.rmSync(path, { force: true });
  }
}

/** Longest line a show pipe accepts; a longer one is dropped, since a value that long is not one to read. */
export const SHOW_PIPE_MAX_LINE = 200;

export interface LineReader {
  /** The complete lines written since the last read, and whether the writer has closed the pipe. */
  readonly read: () => { readonly lines: ReadonlyArray<string>; readonly closed: boolean };
  /** Stops reading and removes the pipe. */
  readonly close: () => void;
}

/**
 * Opens the pipe at `path` to take the lines a command writes for the user, without ever
 * blocking: before any writer opens it, a read returns nothing and the pipe stays open.
 * Fails, removing whatever is at `path`, when it is not a pipe.
 */
export function openLineReader(path: string): LineReader {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = NodeFS.constants;
  let fd: number;
  try {
    fd = NodeFS.openSync(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
    if (!NodeFS.fstatSync(fd).isFIFO()) {
      NodeFS.closeSync(fd);
      throw new Error(`${path} is not a named pipe`);
    }
  } catch (error) {
    NodeFS.rmSync(path, { force: true });
    throw error;
  }
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1024);
  let pending = "";
  let wroteOnce = false;
  let open = true;
  const linesIn = (text: string) => {
    const parts = `${pending}${text}`.split("\n");
    pending = parts.pop() ?? "";
    if (pending.length > SHOW_PIPE_MAX_LINE) pending = "";
    return parts
      .map((part) => part.trim())
      .filter((line) => line !== "" && line.length <= SHOW_PIPE_MAX_LINE);
  };
  const close = () => {
    if (!open) return;
    open = false;
    pending = "";
    NodeFS.closeSync(fd);
    NodeFS.rmSync(path, { force: true });
  };
  return {
    read: () => {
      if (!open) return { lines: [], closed: true };
      const lines: Array<string> = [];
      while (true) {
        let read: number;
        try {
          read = NodeFS.readSync(fd, buffer, 0, buffer.length, null);
        } catch (error) {
          // EAGAIN: a writer holds the pipe open but has written nothing new.
          if (errorCode(error) !== "EAGAIN") throw error;
          wroteOnce = true;
          return { lines, closed: false };
        }
        if (read > 0) {
          wroteOnce = true;
          lines.push(...linesIn(decoder.decode(buffer.subarray(0, read), { stream: true })));
          continue;
        }
        // Zero bytes means no writer: none yet, or the one that wrote has closed it.
        if (!wroteOnce) return { lines, closed: false };
        lines.push(...linesIn(`${decoder.decode()}\n`));
        return { lines, closed: true };
      }
    },
    close,
  };
}
