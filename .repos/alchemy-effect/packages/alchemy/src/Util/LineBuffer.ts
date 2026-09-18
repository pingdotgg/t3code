/**
 * Buffers arbitrary text chunks and emits complete lines. Call `flush` when
 * the source closes to emit a trailing partial line.
 */
export const makeLineBuffer = (onLine: (line: string) => void) => {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffer === "") return;
      onLine(buffer);
      buffer = "";
    },
  };
};
