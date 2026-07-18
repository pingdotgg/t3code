import { describe, expect, it } from "vite-plus/test";

import {
  trimVoiceTraceSessions,
  upsertVoiceTraceEntry,
  type VoiceTraceEntry,
  type VoiceTraceSession,
} from "./voiceTraceStore";

describe("upsertVoiceTraceEntry", () => {
  it("updates a cumulative transcript in place", () => {
    const partial = { ...entry(1, "What does the"), kind: "user" as const };
    const refined = {
      ...partial,
      timestamp: "2026-07-15T00:00:01.000Z",
      text: "What does the save function do in WordPress?",
    };

    const entries = upsertVoiceTraceEntry([partial], refined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("What does the save function do in WordPress?");
    expect(entries[0]?.timestamp).toBe(partial.timestamp);
  });
});

function entry(index: number, text = `entry ${index}`): VoiceTraceEntry {
  return {
    id: `entry-${index}`,
    timestamp: "2026-07-15T00:00:00.000Z",
    kind: "system",
    title: `Entry ${index}`,
    text,
  };
}

function session(index: number, entries: readonly VoiceTraceEntry[]): VoiceTraceSession {
  return {
    id: `session-${index}`,
    startedAt: "2026-07-15T00:00:00.000Z",
    endedAt: null,
    status: "active",
    title: `Session ${index}`,
    environmentId: "primary",
    threadId: `thread-${index}`,
    entries,
  };
}

describe("trimVoiceTraceSessions", () => {
  it("keeps the 20 newest sessions", () => {
    const sessions = Array.from({ length: 25 }, (_, index) => session(index, []));
    expect(trimVoiceTraceSessions(sessions).map((item) => item.id)).toEqual(
      sessions.slice(0, 20).map((item) => item.id),
    );
  });

  it("keeps the newest 250 entries within a session", () => {
    const entries = Array.from({ length: 300 }, (_, index) => entry(index));
    const [trimmed] = trimVoiceTraceSessions([session(0, entries)]);
    expect(trimmed?.entries).toHaveLength(250);
    expect(trimmed?.entries[0]?.id).toBe("entry-50");
  });

  it("bounds persisted trace text while retaining the newest activity", () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(index, "x".repeat(10_000)));
    const [trimmed] = trimVoiceTraceSessions([session(0, entries)]);
    expect(trimmed?.entries.length).toBeLessThan(20);
    expect(trimmed?.entries.at(-1)?.id).toBe("entry-19");
  });
});
