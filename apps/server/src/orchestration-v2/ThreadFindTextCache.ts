import type { OrchestrationV2SearchThreadInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_ENTRIES = 8192;
const TIME_TO_LIVE_MS = 60_000;

export class TextKey extends Data.Class<{
  text: string;
  role: "user" | "assistant" | "plan";
  streaming: boolean;
  hasContext: boolean;
  cwd: string | undefined;
  skills: NonNullable<OrchestrationV2SearchThreadInput["skills"]>;
}> {}

interface Entry {
  readonly key: TextKey;
  readonly segments: readonly string[];
  readonly bytes: number;
  readonly expiresAt: number;
}

function entryBytes(key: TextKey, segments: readonly string[]) {
  const characters =
    key.text.length +
    (key.cwd?.length ?? 0) +
    key.skills.reduce(
      (total, skill) => total + skill.name.length + (skill.displayName?.length ?? 0),
      0,
    ) +
    segments.reduce((total, text) => total + text.length, 0);
  return 2 * characters + 256 + 32 * key.skills.length + 16 * segments.length;
}

export const makeThreadFindTextCache = Effect.fn("makeThreadFindTextCache")(function* (
  parse: (key: TextKey) => readonly string[],
) {
  const clock = yield* Clock.Clock;
  const entries = MutableHashMap.empty<TextKey, Entry>();
  const recency = new Set<Entry>();
  let retainedBytes = 0;
  const remove = (entry: Entry) => {
    MutableHashMap.remove(entries, entry.key);
    recency.delete(entry);
    retainedBytes -= entry.bytes;
  };
  return {
    get: (key: TextKey) =>
      Effect.sync(() => {
        const now = clock.currentTimeMillisUnsafe();
        const cached = MutableHashMap.get(entries, key);
        if (Option.isSome(cached)) {
          const entry = cached.value;
          if (entry.expiresAt > now) {
            recency.delete(entry);
            recency.add(entry);
            return entry.segments;
          }
          remove(entry);
        }
        const segments = parse(key);
        const bytes = entryBytes(key, segments);
        if (bytes > MAX_ENTRY_BYTES) return segments;
        for (const oldest of recency) {
          if (retainedBytes + bytes <= MAX_CACHE_BYTES && recency.size < MAX_ENTRIES) break;
          remove(oldest);
        }
        const entry = { key, segments, bytes, expiresAt: now + TIME_TO_LIVE_MS };
        MutableHashMap.set(entries, key, entry);
        recency.add(entry);
        retainedBytes += bytes;
        return segments;
      }),
  };
});
