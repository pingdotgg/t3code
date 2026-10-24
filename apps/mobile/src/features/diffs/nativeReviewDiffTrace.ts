// Opt in at bundle time for bounded Release diagnostics; never log source or RPC payloads.
const MAX_TRACE_EVENTS = 1_000;
let eventCount = 0;
let nextId = 0;
const ids = new Map<unknown, number>();
let fileSink: Promise<import("expo-file-system").File | null> | undefined;

export function diffHighlightTraceHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function appendTraceLine(line: string) {
  fileSink ??= import("expo-file-system")
    .then(({ File, Paths }) => {
      const file = new File(Paths.document, "t3-diff-highlight-trace.jsonl");
      file.create({ overwrite: true, intermediates: true });
      return file;
    })
    .catch(() => null);
  // File.write is async in Expo 58. Serialize appends to preserve sequence order.
  fileSink = fileSink.then(async (file) => {
    if (!file) return null;
    try {
      await file.write(line + "\n", { append: true });
      return file;
    } catch {
      return null;
    }
  });
}

export function diffHighlightTraceId(value: unknown): number {
  if (process.env.EXPO_PUBLIC_T3_DIFF_TRACE !== "1" || eventCount >= MAX_TRACE_EVENTS) return 0;
  let id = ids.get(value);
  if (id === undefined) {
    id = ++nextId;
    ids.set(value, id);
  }
  return id;
}

export function traceDiffHighlight(
  event: string,
  fields: Readonly<Record<string, number | boolean | string | undefined>> = {},
) {
  if (process.env.EXPO_PUBLIC_T3_DIFF_TRACE !== "1" || eventCount >= MAX_TRACE_EVENTS) return;
  eventCount += 1;
  const line = JSON.stringify({
    event,
    seq: eventCount,
    at: Math.round(performance.now()),
    ...fields,
  });
  appendTraceLine(line);
  console.warn("[diff-highlight-trace] " + line);
  if (eventCount === MAX_TRACE_EVENTS) ids.clear();
}
