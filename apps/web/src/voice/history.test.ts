/**
 * History behavior tests: durable session records survive reconnect and
 * reload, transcript deltas never write per delta, tool/command/navigation/
 * error outcomes land with their identities, retention is bounded, and
 * export/clear behave. All storage is the in-memory backend; localStorage
 * satisfies the same synchronous interface.
 */
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  VOICE_HISTORY_INDEX_KEY,
  VOICE_HISTORY_SESSION_KEY_PREFIX,
  createVoiceHistoryRecorder,
  createVoiceHistoryStore,
  exportVoiceHistory,
  type VoiceHistoryStorage,
} from "./history";
import type { VoiceLiveClientEvent } from "./live-client";

// ---------------------------------------------------------------------------
// Counting memory storage: counts payload writes to key on write discipline.
// ---------------------------------------------------------------------------

const makeCountingStorage = () => {
  const map = new Map<string, string>();
  const writes = new Map<string, number>();
  const storage: VoiceHistoryStorage = {
    getItem: (name) => map.get(name) ?? null,
    setItem: (name, value) => {
      map.set(name, value);
      writes.set(name, (writes.get(name) ?? 0) + 1);
    },
    removeItem: (name) => {
      map.delete(name);
    },
  };
  return { storage, map, writes, writeCount: (name: string) => writes.get(name) ?? 0 };
};

const transcript = (
  channel: "input" | "output",
  utterance: string,
  delta: string,
): VoiceLiveClientEvent => ({ type: "transcript", channel, delta, utterance });

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe("voice history store", () => {
  it("round-trips sessions through the index and payload keys", () => {
    const { storage } = makeCountingStorage();
    const store = createVoiceHistoryStore({ storage });
    store.writeSession({
      id: "s1",
      sessionId: "live_1",
      startedAt: 100,
      endedAt: 200,
      entries: [{ kind: "command", text: "done", at: 150 }],
    });
    expect(store.listSessions()).toEqual([
      { id: "s1", sessionId: "live_1", startedAt: 100, endedAt: 200, entryCount: 1 },
    ]);
    expect(store.readSession("s1")?.entries).toEqual([{ kind: "command", text: "done", at: 150 }]);
  });

  it("lists sessions oldest first and trims beyond maxSessions with payloads", () => {
    const { storage, map } = makeCountingStorage();
    const store = createVoiceHistoryStore({ storage, maxSessions: 2 });
    store.writeSession({ id: "a", startedAt: 300, entries: [] });
    store.writeSession({ id: "b", startedAt: 200, entries: [] });
    store.writeSession({ id: "c", startedAt: 100, entries: [] });
    expect(store.listSessions().map((summary) => summary.id)).toEqual(["b", "a"]);
    expect(map.has(`${VOICE_HISTORY_SESSION_KEY_PREFIX}c`)).toBe(false);
    expect(store.readSession("c")).toBeUndefined();
  });

  it("survives malformed storage without throwing", () => {
    const { storage } = makeCountingStorage();
    storage.setItem(VOICE_HISTORY_INDEX_KEY, "{not json");
    storage.setItem(`${VOICE_HISTORY_SESSION_KEY_PREFIX}x`, "[1,2");
    const store = createVoiceHistoryStore({ storage });
    expect(store.listSessions()).toEqual([]);
    expect(store.readSession("x")).toBeUndefined();
  });

  it("drops invalid entries but keeps valid ones on decode", () => {
    const { storage } = makeCountingStorage();
    const store = createVoiceHistoryStore({ storage });
    store.writeSession({
      id: "s",
      startedAt: 1,
      entries: [
        { kind: "error", code: "invalid_request", message: "bad", at: 2 },
        { kind: "utterance", channel: "sideways", text: "no" } as never,
      ],
    });
    // The write serialized both entries; decode drops the invalid one.
    expect(store.readSession("s")?.entries).toEqual([
      { kind: "error", code: "invalid_request", message: "bad", at: 2 },
    ]);
  });

  it("clearAll removes every payload and the index", () => {
    const { storage, map } = makeCountingStorage();
    const store = createVoiceHistoryStore({ storage });
    store.writeSession({ id: "a", startedAt: 1, entries: [] });
    store.writeSession({ id: "b", startedAt: 2, entries: [] });
    store.clearAll();
    expect(store.listSessions()).toEqual([]);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

describe("voice history recorder", () => {
  it("buffers transcript deltas in memory: no payload write per delta", () => {
    const { storage, writes, writeCount } = makeCountingStorage();
    const recorder = createVoiceHistoryRecorder({
      store: createVoiceHistoryStore({ storage }),
      now: () => 1000,
    });
    recorder.beginSession();
    // The first delta opens the first utterance: that boundary persists.
    recorder.record(transcript("output", "out-1", "word0 "));
    const afterFirst = writeCount(`${VOICE_HISTORY_SESSION_KEY_PREFIX}voice-1000-1`);
    expect(afterFirst).toBeGreaterThan(0);
    for (let index = 1; index < 50; index++) {
      recorder.record(transcript("output", "out-1", `word${index} `));
    }
    expect(writeCount(`${VOICE_HISTORY_SESSION_KEY_PREFIX}voice-1000-1`)).toBe(afterFirst);
    // A second utterance opening is the boundary that persists.
    recorder.record(transcript("input", "in-1", "hello"));
    expect(writeCount(`${VOICE_HISTORY_SESSION_KEY_PREFIX}voice-1000-1`)).toBeGreaterThan(
      afterFirst,
    );
    expect(writes.size).toBeLessThanOrEqual(2);
  });

  it("folds consecutive deltas into one utterance entry with identity", () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    recorder.beginSession();
    recorder.record(transcript("output", "out-1", "Hel"));
    recorder.record(transcript("output", "out-1", "lo"));
    recorder.record(transcript("input", "in-1", "hi"));
    recorder.record(transcript("output", "out-2", "back"));
    recorder.endSession();
    const session = recorder.listSessions()[0];
    const entries = recorder.readSession(session!.id)!.entries;
    expect(entries).toEqual([
      {
        kind: "utterance",
        id: "output:out-1",
        channel: "output",
        text: "Hello",
        startedAt: 1000,
        updatedAt: 1000,
      },
      {
        kind: "utterance",
        id: "input:in-1",
        channel: "input",
        text: "hi",
        startedAt: 1000,
        updatedAt: 1000,
      },
      {
        kind: "utterance",
        id: "output:out-2",
        channel: "output",
        text: "back",
        startedAt: 1000,
        updatedAt: 1000,
      },
    ]);
  });

  it("records commands, errors, marks, and navigation with identities", () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 5000 });
    recorder.beginSession();
    recorder.record({ type: "command_result", text: "Oracle is open." });
    recorder.record({
      type: "error",
      error: { code: "environment_unreachable", message: "down" },
    });
    recorder.record({
      type: "timing",
      record: { mark: "function_call_received", atMs: 4900, detail: "voice.openThread" },
    });
    recorder.recordNavigation(
      { status: "failed", error: { code: "thread_not_found", message: "gone" } },
      {
        environmentId: "env-1" as EnvironmentId,
        threadId: "thread-1" as ThreadId,
      },
    );
    recorder.endSession();
    const entries = recorder.readSession(recorder.listSessions()[0]!.id)!.entries;
    expect(entries).toEqual([
      { kind: "command", text: "Oracle is open.", at: 5000 },
      { kind: "error", code: "environment_unreachable", message: "down", at: 5000 },
      { kind: "mark", mark: "function_call_received", detail: "voice.openThread", atMs: 4900 },
      {
        kind: "navigation",
        status: "failed",
        environmentId: "env-1",
        threadId: "thread-1",
        error: "gone",
        at: 5000,
      },
    ]);
  });

  it("records tool outcomes with the prefix stripped and allowlisted input only", async () => {
    let clock = 1000;
    const recorder = createVoiceHistoryRecorder({ now: () => clock });
    recorder.beginSession();
    await recorder.recordToolExecution(
      "voice.openThread",
      {
        environmentId: "env-1",
        threadId: "thread-1",
        secretToken: "never-record-this",
        apiKey: "nope",
      },
      async () => {
        clock = 1150;
        return { acknowledged: true };
      },
    );
    await expect(
      recorder.recordToolExecution("voice.readThread", { threadId: "t2" }, async () => {
        clock = 1200;
        throw new Error("disconnected");
      }),
    ).rejects.toThrow("disconnected");
    recorder.endSession();
    const entries = recorder.readSession(recorder.listSessions()[0]!.id)!.entries;
    expect(entries).toEqual([
      {
        kind: "tool",
        name: "openThread",
        status: "ok",
        input: { environmentId: "env-1", threadId: "thread-1" },
        result: { acknowledged: true },
        startedAt: 1000,
        endedAt: 1150,
      },
      {
        kind: "tool",
        name: "readThread",
        status: "failed",
        input: { threadId: "t2" },
        startedAt: 1150,
        endedAt: 1200,
        error: "disconnected",
      },
    ]);
  });

  it("records the resolved stale-session response shape with dispatch identity and session state", async () => {
    let clock = 1000;
    const { storage } = makeCountingStorage();
    const recorder = createVoiceHistoryRecorder({
      store: createVoiceHistoryStore({ storage }),
      now: () => clock,
    });
    recorder.beginSession();
    // The incident shape: continueThread resolved successfully, but the
    // follow-up landed on a stale provider session reported in-band.
    await recorder.recordToolExecution(
      "voice.continueThread",
      {
        requestId: "vr_1",
        environmentId: "env-1",
        threadId: "thread-1",
        task: "just the risks",
        authHeader: "never-record-this",
      },
      async () => {
        clock = 1400;
        return {
          requestId: "vr_1",
          environment: { environmentId: "env-1", status: "ok" },
          commandId: "cmd_1",
          threadId: "thread-1",
          messageId: "msg_1",
          dispatchSequence: 42,
          session: { status: "error", lastError: "provider session stale; start a new thread" },
          turns: [{ userText: "raw thread content that must not be recorded" }],
        };
      },
    );
    recorder.endSession();

    const session = recorder.listSessions()[0]!;
    const entry = recorder
      .readSession(session.id)!
      .entries.find((candidate) => candidate.kind === "tool");
    expect(entry).toEqual({
      kind: "tool",
      name: "continueThread",
      status: "ok",
      input: {
        requestId: "vr_1",
        environmentId: "env-1",
        threadId: "thread-1",
        task: "just the risks",
      },
      result: {
        requestId: "vr_1",
        commandId: "cmd_1",
        messageId: "msg_1",
        dispatchSequence: 42,
        environmentStatus: "ok",
        sessionStatus: "error",
        sessionLastError: "provider session stale; start a new thread",
      },
      startedAt: 1000,
      endedAt: 1400,
    });
    // The recorded response shape survives a reload and an export.
    const reloaded = createVoiceHistoryStore({ storage });
    expect(reloaded.readSession(session.id)!.entries).toEqual([entry]);
    const exported = JSON.parse(exportVoiceHistory(reloaded, () => 9000)) as {
      sessions: Array<{ entries: Array<{ result?: { sessionLastError?: string } }> }>;
    };
    expect(exported.sessions[0]!.entries[0]!.result!.sessionLastError).toBe(
      "provider session stale; start a new thread",
    );
  });

  it("records an in-band environment failure on a resolved response", async () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    recorder.beginSession();
    await recorder.recordToolExecution(
      "voice.openThread",
      { environmentId: "env-1", threadId: "thread-404" },
      async () => ({
        environment: {
          environmentId: "env-1",
          status: "error",
          error: { code: "thread_not_found", message: "gone" },
        },
        acknowledged: false,
      }),
    );
    recorder.endSession();
    const entry = recorder
      .readSession(recorder.listSessions()[0]!.id)!
      .entries.find((candidate) => candidate.kind === "tool");
    expect(entry).toMatchObject({
      name: "openThread",
      status: "ok",
      result: {
        environmentStatus: "error",
        environmentError: "thread_not_found: gone",
        acknowledged: false,
      },
    });
  });

  it("records semantic control refusals and the controlId identity", async () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    recorder.beginSession();
    await recorder.recordToolExecution("voice.clickControl", { controlId: "ctl-9" }, async () => ({
      control: {
        controlId: "ctl-9",
        name: "Connect",
        state: "disabled",
        message: "This control is disabled.",
      },
    }));
    await recorder.recordToolExecution(
      "voice.listControls",
      { environmentId: "env-1" },
      async () => ({
        environment: { environmentId: "env-1", status: "ok" },
        controls: [
          { controlId: "ctl-1", name: "Connect", state: "enabled" },
          { controlId: "ctl-2", name: "Mute", state: "disabled" },
        ],
      }),
    );
    recorder.endSession();
    const entries = recorder
      .readSession(recorder.listSessions()[0]!.id)!
      .entries.filter((candidate) => candidate.kind === "tool");
    expect(entries[0]).toMatchObject({
      name: "clickControl",
      input: { controlId: "ctl-9" },
      result: {
        controls: [
          {
            controlId: "ctl-9",
            name: "Connect",
            state: "disabled",
            message: "This control is disabled.",
          },
        ],
      },
    });
    expect(entries[1]).toMatchObject({
      name: "listControls",
      result: {
        environmentStatus: "ok",
        controls: [
          { controlId: "ctl-1", name: "Connect", state: "enabled" },
          { controlId: "ctl-2", name: "Mute", state: "disabled" },
        ],
      },
    });
  });

  it("drops unknown response fields from the recorded result", async () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    recorder.beginSession();
    await recorder.recordToolExecution(
      "voice.observeThread",
      { environmentId: "env-1", threadId: "thread-1" },
      async () => ({
        environment: { environmentId: "env-1", status: "ok" },
        threadId: "thread-1",
        apiKey: "sk-never",
        authorization: "Bearer never",
        turns: [{ userText: "raw thread content" }],
      }),
    );
    recorder.endSession();
    const entry = recorder
      .readSession(recorder.listSessions()[0]!.id)!
      .entries.find((candidate) => candidate.kind === "tool");
    expect(JSON.stringify(entry)).not.toContain("sk-never");
    expect(JSON.stringify(entry)).not.toContain("raw thread content");
  });

  it("ends the open session on the closed state and starts a fresh record on reconnect", () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    recorder.beginSession();
    recorder.record(transcript("input", "in-1", "first session"));
    recorder.record({ type: "state", state: "closed" });
    recorder.beginSession();
    recorder.record(transcript("input", "in-1", "second session"));
    recorder.endSession();
    const sessions = recorder.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.endedAt).toBe(1000);
    const first = recorder.readSession(sessions[0]!.id)!.entries;
    const second = recorder.readSession(sessions[1]!.id)!.entries;
    expect(first).toEqual([
      {
        kind: "utterance",
        id: "input:in-1",
        channel: "input",
        text: "first session",
        startedAt: 1000,
        updatedAt: 1000,
      },
    ]);
    expect(second).toEqual([
      {
        kind: "utterance",
        id: "input:in-1",
        channel: "input",
        text: "second session",
        startedAt: 1000,
        updatedAt: 1000,
      },
    ]);
  });

  it("attaches the live session identity to the record", () => {
    let sessionId: string | undefined;
    const recorder = createVoiceHistoryRecorder({
      now: () => 1000,
      sessionIdentity: () => sessionId,
    });
    recorder.beginSession();
    recorder.record(transcript("input", "in-1", "hello"));
    sessionId = "live_sess_9";
    recorder.record({ type: "state", state: "live" });
    recorder.endSession();
    expect(recorder.listSessions()[0]!.sessionId).toBe("live_sess_9");
  });

  it("drops events with no open session", () => {
    const { storage, map } = makeCountingStorage();
    const recorder = createVoiceHistoryRecorder({
      store: createVoiceHistoryStore({ storage }),
      now: () => 1000,
    });
    recorder.record(transcript("input", "in-1", "orphan"));
    recorder.record({ type: "state", state: "closed" });
    expect(map.size).toBe(0);
    expect(recorder.listSessions()).toEqual([]);
  });

  it("trims entries beyond the per-session cap, keeping the latest", () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000, maxEntriesPerSession: 3 });
    recorder.beginSession();
    for (let index = 1; index <= 5; index++) {
      recorder.record({ type: "command_result", text: `c${index}` });
    }
    recorder.endSession();
    const entries = recorder.readSession(recorder.listSessions()[0]!.id)!.entries;
    expect(entries.map((entry) => (entry.kind === "command" ? entry.text : ""))).toEqual([
      "c3",
      "c4",
      "c5",
    ]);
  });

  it("notifies subscribers and keeps a stable snapshot across boundary writes", () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    const seen: number[] = [];
    recorder.subscribe(() => {
      seen.push(recorder.getSessionsSnapshot().length);
    });
    const first = recorder.getSessionsSnapshot();
    recorder.beginSession();
    expect(seen).toEqual([1]);
    // Opening an utterance is a boundary that moves the index; folding a
    // further delta into the open utterance keeps the snapshot identity.
    recorder.record(transcript("output", "out-1", "hel"));
    const beforeFold = recorder.getSessionsSnapshot();
    recorder.record(transcript("output", "out-1", "lo"));
    expect(recorder.getSessionsSnapshot()).toBe(beforeFold);
    recorder.clear();
    expect(seen[seen.length - 1]).toBe(0);
    expect(recorder.getSessionsSnapshot()).not.toBe(first);
  });

  it("clear drops the open record and every saved session", () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    recorder.beginSession();
    recorder.record({ type: "command_result", text: "saved" });
    recorder.endSession();
    recorder.beginSession();
    recorder.clear();
    expect(recorder.listSessions()).toEqual([]);
    expect(recorder.readSession("anything")).toBeUndefined();
  });

  it("survives a reload: a fresh recorder reads the same storage", () => {
    const { storage } = makeCountingStorage();
    const first = createVoiceHistoryRecorder({
      store: createVoiceHistoryStore({ storage }),
      now: () => 1000,
    });
    first.beginSession();
    first.record(transcript("output", "out-1", "recoverable"));
    first.endSession();
    const second = createVoiceHistoryRecorder({
      store: createVoiceHistoryStore({ storage }),
      now: () => 2000,
    });
    const sessions = second.listSessions();
    expect(sessions).toHaveLength(1);
    expect(second.readSession(sessions[0]!.id)!.entries).toEqual([
      {
        kind: "utterance",
        id: "output:out-1",
        channel: "output",
        text: "recoverable",
        startedAt: 1000,
        updatedAt: 1000,
      },
    ]);
  });

  it("flush persists buffered deltas mid-session", () => {
    const recorder = createVoiceHistoryRecorder({ now: () => 1000 });
    recorder.beginSession();
    recorder.record(transcript("input", "in-1", "half said"));
    recorder.flush();
    const session = recorder.listSessions()[0]!;
    expect(recorder.readSession(session.id)!.entries).toEqual([
      {
        kind: "utterance",
        id: "input:in-1",
        channel: "input",
        text: "half said",
        startedAt: 1000,
        updatedAt: 1000,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("voice history export", () => {
  it("exports every saved session with entries and metadata", () => {
    const { storage } = makeCountingStorage();
    const store = createVoiceHistoryStore({ storage });
    const recorder = createVoiceHistoryRecorder({ store, now: () => 1000 });
    recorder.beginSession();
    recorder.record({ type: "command_result", text: "done" });
    recorder.endSession();
    const parsed = JSON.parse(exportVoiceHistory(store, () => 9000)) as {
      kind: string;
      version: number;
      exportedAt: number;
      sessions: Array<{ id: string; entries: unknown[] }>;
    };
    expect(parsed.kind).toBe("t3code-voice-history");
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe(9000);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]!.entries).toHaveLength(1);
  });
});
