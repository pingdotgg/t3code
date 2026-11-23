// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
// One-read named pipes for secrets the agent's shell commands read. The value stays in this
// process's memory and streams to the first reader; it is never written to disk.
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
