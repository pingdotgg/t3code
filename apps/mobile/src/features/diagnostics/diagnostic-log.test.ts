import { describe, expect, it } from "vite-plus/test";

import {
  createDiagnosticLog,
  type DiagnosticAppIdentity,
  type DiagnosticLogStorage,
} from "./diagnostic-log";

const app: DiagnosticAppIdentity = {
  version: "1.2.3",
  build: "456",
  updateId: "update-a",
  runtimeVersion: "runtime-a",
  platform: "ios",
  osVersion: "26.0",
};
const now = () => "2026-11-12T00:00:00.000Z";

function setup() {
  let current = "";
  let previous = "";
  let unavailable = false;
  const storage: DiagnosticLogStorage = {
    size: () => new TextEncoder().encode(current).byteLength,
    append(bytes) {
      if (unavailable) throw new Error("Disk unavailable");
      current += new TextDecoder().decode(bytes);
    },
    rotate() {
      previous = current;
      current = "";
    },
    read: () => previous + current,
    clear() {
      current = "";
      previous = "";
    },
  };
  return {
    storage,
    log: createDiagnosticLog(storage, "session-a", now),
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

describe("saved mobile diagnostics", () => {
  it("keeps the previous launch's events and identity when a new session starts", () => {
    const { storage, log } = setup();
    log.record({ type: "app.started", app });
    log.record({ type: "thread.selected", environmentId: "env-a", threadId: "thread-a" });
    log.record({ type: "navigation.gate", phase: "queued", pending: 1 });

    const restarted = createDiagnosticLog(storage, "session-b", now);
    restarted.record({ type: "app.started", app: { ...app, updateId: "update-b" } });
    const report = restarted.report({ ...app, updateId: "update-b" });
    const events = storage
      .read()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      { time: now(), session: "session-a", type: "app.started", app },
      {
        time: now(),
        session: "session-a",
        type: "thread.selected",
        environmentId: "env-a",
        threadId: "thread-a",
      },
      { time: now(), session: "session-a", type: "navigation.gate", phase: "queued", pending: 1 },
      {
        time: now(),
        session: "session-b",
        type: "app.started",
        app: { ...app, updateId: "update-b" },
      },
    ]);
    expect(report).toContain('"build":"456"');
    expect(report).toContain('"updateId":"update-a"');
    expect(report).toContain('"updateId":"update-b"');
  });

  it("rotates by encoded byte size, discarding the oldest history", () => {
    const { storage, log } = setup();
    for (let index = 0; index < 500; index += 1) {
      log.record({
        type: "thread.selected",
        environmentId: "環境".repeat(100),
        threadId: `thread-${index}`,
      });
    }
    const retained = storage.read();
    expect(new TextEncoder().encode(retained).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(retained).not.toContain('"threadId":"thread-0"');
    expect(retained).toContain('"threadId":"thread-499"');
    const threads = retained
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).threadId as string);
    expect(threads.map((thread) => Number(thread.slice("thread-".length)))).toEqual(
      [...threads].map((thread) => Number(thread.slice("thread-".length))).sort((a, b) => a - b),
    );
  });

  it("does not interrupt navigation on write failure, and records again once storage recovers", () => {
    const { log, setUnavailable } = setup();
    setUnavailable(true);
    expect(() => log.record({ type: "app.state", state: "active" })).not.toThrow();
    setUnavailable(false);
    log.record({ type: "app.state", state: "background" });
    const report = log.report(app);
    expect(report).toContain('"droppedEventsThisSession":1');
    expect(report).toContain('"state":"background"');
    expect(report).not.toContain("Disk unavailable");
  });

  it("drops oversized events without displacing saved history", () => {
    const { log, storage } = setup();
    log.record({ type: "app.started", app });
    const before = storage.read();
    log.record({ type: "thread.selected", environmentId: "env", threadId: "x".repeat(9000) });
    expect(storage.read()).toBe(before);
    expect(log.report(app)).toContain('"droppedEventsThisSession":1');
  });

  it("clears every retained file and continues recording", () => {
    const { log, storage } = setup();
    for (let index = 0; index < 200; index += 1) {
      log.record({
        type: "thread.selected",
        environmentId: "env",
        threadId: `old-${index}-${"x".repeat(1000)}`,
      });
    }
    log.clear();
    expect(storage.read()).toBe("");
    log.record({ type: "app.started", app });
    expect(log.report(app)).not.toContain("old-");
    expect(log.report(app)).toContain('"type":"app.started"');
  });
});
