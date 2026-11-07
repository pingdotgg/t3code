import type { LogEntry } from "./Model.ts";

const CAPTURE_BYTES = 256 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const TRUNCATED = "[Earlier output omitted from preview; full output is in the run log.]";

/** Bounded live previews; every original entry is persisted before trimming. */
export const makeCapture = (limits = { capture: CAPTURE_BYTES, total: TOTAL_BYTES }) => {
  const buffers = new Map<Array<LogEntry>, number>();
  let total = 0;
  const size = (entry: LogEntry) => Buffer.byteLength(entry.message, "utf8") + 64;
  const release = (buffer: Array<LogEntry>) => {
    total -= buffers.get(buffer) ?? 0;
    buffers.delete(buffer);
    buffer.length = 0;
  };
  const trim = (buffer: Array<LogEntry>, limit: number) => {
    let bytes = buffers.get(buffer) ?? 0;
    let removed = false;
    while (bytes > limit && buffer.length > 0) {
      const entry = buffer.shift()!;
      const cost = size(entry);
      bytes -= cost;
      total -= cost;
      removed = true;
    }
    if (removed && buffer.length > 0 && buffer[0]!.message !== TRUNCATED) {
      const entry = {
        level: "info",
        message: TRUNCATED,
        time: buffer[0]!.time,
      };
      buffer.unshift(entry);
      bytes += size(entry);
      total += size(entry);
    }
    if (bytes === 0) buffers.delete(buffer);
    else buffers.set(buffer, bytes);
  };
  const create = (persist: (entry: LogEntry) => void): Array<LogEntry> => {
    const buffer: Array<LogEntry> = [];
    buffer.push = (...entries) => {
      for (const entry of entries) {
        persist(entry);
        // A single oversized message must not defeat either preview limit.
        const maxChars = Math.max(
          0,
          Math.floor((Math.min(limits.capture, limits.total) - 256) / 4),
        );
        const preview =
          entry.message.length > maxChars
            ? {
                ...entry,
                message: `${TRUNCATED}\n${maxChars === 0 ? "" : entry.message.slice(-maxChars)}`,
              }
            : entry;
        Array.prototype.push.call(buffer, preview);
        const cost = size(preview);
        buffers.set(buffer, (buffers.get(buffer) ?? 0) + cost);
        total += cost;
        trim(buffer, Math.max(0, limits.capture - 256));
        while (total > limits.total && buffers.size > 0) {
          const oldest = buffers.keys().next().value!;
          release(oldest);
        }
      }
      return buffer.length;
    };
    return buffer;
  };
  return { create, release };
};
