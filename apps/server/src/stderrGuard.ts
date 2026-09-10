type StreamWrite = (...args: readonly never[]) => boolean;

interface GuardableStream {
  write: StreamWrite;
  readonly on: (event: "error", listener: () => void) => unknown;
}

/**
 * Stop a failed write on this process's stderr from killing the process.
 *
 * The desktop app runs the server as a child with piped stdio, so its stderr
 * can start failing with `EIO` while the process is otherwise healthy. The
 * server's own output goes through the logger and survives that, but Node
 * prints process warnings itself from `node:internal/process/warning`, whose
 * `writeOut` calls `console.error` with no error handling. That makes any
 * warning, including one Node raises on its own, a fatal uncaught exception
 * once stderr is unwritable.
 *
 * Wrapping the write leaves Node's warning formatting and `--trace-warnings`
 * alone and only removes the ability to crash. A swallowed write reports
 * success so callers do not wait on a `drain` event that will never arrive.
 */
export const guardStderr = (stream: GuardableStream): void => {
  const write = stream.write.bind(stream);
  stream.write = (...args) => {
    try {
      return write(...args);
    } catch {
      return true;
    }
  };
  stream.on("error", () => {});
};
