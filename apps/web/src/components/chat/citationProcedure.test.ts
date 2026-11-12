import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import {
  type CitedThreadSnapshot,
  citedThreadSnapshot,
  loadCitedHistory,
  resolveCitationPhase,
} from "./citationProcedure";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

function scriptedHistory(snapshots: ReadonlyArray<CitedThreadSnapshot | null>) {
  const controller = new AbortController();
  let reads = 0;
  let loads = 0;
  return {
    controller,
    get loads() {
      return loads;
    },
    run: (results: ReadonlyArray<"loaded" | "noop" | "error"> = []) =>
      loadCitedHistory({
        signal: controller.signal,
        readThread: async () => snapshots[Math.min(reads++, snapshots.length - 1)] ?? null,
        loadThrough: async () => {
          const result = results[loads++] ?? "loaded";
          return result === "error" ? { _tag: "error", message: "offline" } : { _tag: result };
        },
      }),
  };
}

const notLoaded = { message: null, hasMoreHistory: true } satisfies CitedThreadSnapshot;

describe("loadCitedHistory", () => {
  it("finds a cited response that is already loaded without paging", async () => {
    const history = scriptedHistory([{ message: "assistant", hasMoreHistory: true }]);
    await expect(history.run()).resolves.toEqual({ _tag: "found" });
    expect(history.loads).toBe(0);
  });

  it("pages history toward a response outside the loaded window", async () => {
    const history = scriptedHistory([
      notLoaded,
      notLoaded,
      { message: "assistant", hasMoreHistory: true },
    ]);
    await expect(history.run()).resolves.toEqual({ _tag: "found" });
    expect(history.loads).toBe(2);
  });

  it("reports an unavailable response once the thread has no more history", async () => {
    const history = scriptedHistory([notLoaded, { message: null, hasMoreHistory: false }]);
    await expect(history.run()).resolves.toMatchObject({
      _tag: "failed",
      title: "The cited response is unavailable",
    });
  });

  it("rejects a citation that names a user message", async () => {
    const history = scriptedHistory([{ message: "other", hasMoreHistory: false }]);
    await expect(history.run()).resolves.toMatchObject({
      _tag: "failed",
      title: "The citation does not refer to an assistant response",
    });
  });

  it("stops on a failed page", async () => {
    const history = scriptedHistory([notLoaded]);
    await expect(history.run(["error"])).resolves.toMatchObject({
      _tag: "failed",
      title: "Could not load the cited response",
    });
    expect(history.loads).toBe(1);
  });

  it("reports an unavailable response when the store has nothing older to page", async () => {
    const history = scriptedHistory([notLoaded]);
    await expect(history.run(["noop"])).resolves.toMatchObject({
      _tag: "failed",
      title: "The cited response is unavailable",
    });
    expect(history.loads).toBe(1);
  });

  it("gives up after a bounded number of pages that never reach the response", async () => {
    const history = scriptedHistory([notLoaded]);
    await expect(history.run()).resolves.toMatchObject({
      _tag: "failed",
      title: "Could not load the cited response",
    });
    expect(history.loads).toBe(20);
  });

  it("ends quietly when the citation is left mid-load", async () => {
    const history = scriptedHistory([notLoaded]);
    const outcome = history.run();
    history.controller.abort();
    await expect(outcome).resolves.toEqual({ _tag: "aborted" });
  });
});

describe("citedThreadSnapshot", () => {
  const settledHistory = {
    historyCursor: null,
    hasMoreHistory: false,
    loading: false,
    error: null,
    expanded: false,
    latestLocalTurnOrdinal: null,
  };
  const unloaded = {
    thread: null,
    history: settledHistory,
    status: "synchronizing",
    error: null,
    messageId: "cited",
  } satisfies Parameters<typeof citedThreadSnapshot>[0];

  it("keeps waiting while a thread that has not loaded yet is still synchronizing", () => {
    expect(citedThreadSnapshot(unloaded)).toBeNull();
  });

  it("fails the citation when the thread could not load at all", async () => {
    const snapshot = citedThreadSnapshot({ ...unloaded, error: "Thread not found." });
    expect(snapshot).not.toBeNull();
    await expect(scriptedHistory([snapshot]).run()).resolves.toMatchObject({
      _tag: "failed",
      title: "Could not load the cited response",
    });
  });
});

describe("resolveCitationPhase", () => {
  const at = "2026-01-01T00:00:00Z";
  const messageId = MessageId.make("cited");
  const runId = RunId.make("run-1");
  const entry: TimelineEntry = {
    kind: "message",
    id: "cited-entry",
    createdAt: at,
    message: {
      id: messageId,
      role: "assistant",
      text: "Answer",
      runId,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
  const row = {
    kind: "message",
    id: "cited-row",
    message: entry.message,
  } as MessagesTimelineRow;
  const phase = (input: {
    history?: "loading" | "found" | "failed";
    entries?: ReadonlyArray<TimelineEntry>;
    rows?: ReadonlyArray<MessagesTimelineRow>;
  }) =>
    resolveCitationPhase({
      history: { _tag: input.history ?? "loading" },
      messageId,
      entries: input.entries ?? [],
      rows: input.rows ?? [],
    });

  it("waits while the cited response is not in the timeline yet", () => {
    expect(phase({ history: "found" })).toEqual({ _tag: "loading" });
  });

  it("expands the turn that folds the cited response", () => {
    expect(phase({ entries: [entry] })).toEqual({ _tag: "expanding" });
  });

  it("is ready once the cited response has a row, even before paging settles", () => {
    expect(phase({ entries: [entry], rows: [row] })).toEqual({
      _tag: "ready",
      rowId: "cited-row",
    });
  });

  it("fails for a citation that names a user message", () => {
    const userEntry: TimelineEntry = {
      ...entry,
      message: { ...entry.message, role: "user" },
    } as TimelineEntry;
    expect(phase({ entries: [userEntry] })).toEqual({ _tag: "failed" });
  });

  it("fails when the history procedure failed", () => {
    expect(phase({ history: "failed", entries: [entry], rows: [row] })).toEqual({
      _tag: "failed",
    });
  });
});
