import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadUnreadSession,
  resolveUnreadBoundaryIndex,
  type UnreadBoundaryCandidate,
} from "./threadUnread.ts";

const runId = RunId.make("run-1");
const VISITED_AT = "2026-06-20T10:00:00.000Z";
const COMPLETED_AT = "2026-06-20T10:05:00.000Z";
const snapshot = { visitedAt: VISITED_AT, runId, completedAt: COMPLETED_AT };
const unreadThread = { lastVisitedAt: VISITED_AT, latestRun: { runId, completedAt: COMPLETED_AT } };
const readThread = { lastVisitedAt: COMPLETED_AT, latestRun: { runId, completedAt: COMPLETED_AT } };

describe("resolveThreadUnreadSession", () => {
  it("copies the unread window when the latest run completed after the last visit", () => {
    expect(
      resolveThreadUnreadSession(null, {
        threadKey: "env-a:thread-1",
        thread: unreadThread,
        synchronized: true,
      }),
    ).toEqual({ threadKey: "env-a:thread-1", snapshot });
  });

  it.each([
    ["never visited", { ...unreadThread, lastVisitedAt: null }],
    ["a server without visit tracking and no local visit", { latestRun: unreadThread.latestRun }],
    ["already read", readThread],
    ["a run still in progress", { ...unreadThread, latestRun: { runId, completedAt: null } }],
    ["no run", { ...unreadThread, latestRun: null }],
    ["an unparseable visit", { ...unreadThread, lastVisitedAt: "not a date" }],
  ])("opens read for %s", (_label, thread) => {
    expect(
      resolveThreadUnreadSession(null, { threadKey: "thread-1", thread, synchronized: true }),
    ).toEqual({ threadKey: "thread-1", snapshot: null });
  });

  it("waits for the shell instead of settling as read", () => {
    const pending = resolveThreadUnreadSession(null, {
      threadKey: "thread-1",
      thread: null,
      synchronized: true,
    });
    expect(pending).toBeNull();
    expect(
      resolveThreadUnreadSession(pending, {
        threadKey: "thread-1",
        thread: unreadThread,
        synchronized: true,
      })?.snapshot,
    ).toEqual(snapshot);
  });

  it("does not settle as read from a shell cached before a sync", () => {
    const cached = resolveThreadUnreadSession(null, {
      threadKey: "thread-1",
      thread: readThread,
      synchronized: false,
    });
    expect(cached).toBeNull();
    // The sync delivers the completion the cache had missed.
    expect(
      resolveThreadUnreadSession(cached, {
        threadKey: "thread-1",
        thread: unreadThread,
        synchronized: true,
      })?.snapshot,
    ).toEqual(snapshot);
    // A cached shell that is already unread needs no sync to say so.
    expect(
      resolveThreadUnreadSession(null, {
        threadKey: "thread-1",
        thread: unreadThread,
        synchronized: false,
      })?.snapshot,
    ).toEqual(snapshot);
  });

  it("stays frozen while the same thread is open", () => {
    const opened = resolveThreadUnreadSession(null, {
      threadKey: "thread-1",
      thread: unreadThread,
      synchronized: true,
    });
    const laterRun = { runId: RunId.make("run-2"), completedAt: "2026-06-20T11:00:00.000Z" };
    for (const input of [
      // The visit echo, or another device reading the thread.
      { thread: readThread, synchronized: true },
      // A reconnect, then a later completion.
      { thread: readThread, synchronized: false },
      { thread: { lastVisitedAt: COMPLETED_AT, latestRun: laterRun }, synchronized: true },
    ]) {
      expect(resolveThreadUnreadSession(opened, { threadKey: "thread-1", ...input })).toBe(opened);
    }

    const openedRead = resolveThreadUnreadSession(null, {
      threadKey: "thread-1",
      thread: readThread,
      synchronized: true,
    });
    expect(
      resolveThreadUnreadSession(openedRead, {
        threadKey: "thread-1",
        thread: unreadThread,
        synchronized: true,
      }),
    ).toBe(openedRead);
  });

  it("scopes the session to the environment and thread", () => {
    const opened = resolveThreadUnreadSession(null, {
      threadKey: "env-a:thread-1",
      thread: unreadThread,
      synchronized: true,
    });
    // The same thread id in another environment is a different thread.
    expect(
      resolveThreadUnreadSession(opened, {
        threadKey: "env-b:thread-1",
        thread: readThread,
        synchronized: true,
      }),
    ).toEqual({ threadKey: "env-b:thread-1", snapshot: null });
    // Switching away drops the session even before the next shell loads.
    expect(
      resolveThreadUnreadSession(opened, {
        threadKey: "env-b:thread-1",
        thread: null,
        synchronized: true,
      }),
    ).toBeNull();
  });

  it("ends when the thread leaves the screen", () => {
    const opened = resolveThreadUnreadSession(null, {
      threadKey: "thread-1",
      thread: unreadThread,
      synchronized: true,
    });
    const hidden = resolveThreadUnreadSession(opened, {
      threadKey: null,
      thread: unreadThread,
      synchronized: true,
    });
    expect(hidden).toBeNull();
    // Shown again after the visit landed: a new session, now read.
    expect(
      resolveThreadUnreadSession(hidden, {
        threadKey: "thread-1",
        thread: readThread,
        synchronized: true,
      }),
    ).toEqual({ threadKey: "thread-1", snapshot: null });
  });
});

describe("resolveUnreadBoundaryIndex", () => {
  const entry = (time: string, assistantRunId: RunId | null = null): UnreadBoundaryCandidate => ({
    createdAt: `2026-06-20T${time}.000Z`,
    assistantRunId,
  });
  const loaded = { hasMoreHistory: false };

  it("picks the first entry created after the visit", () => {
    const entries = [
      entry("09:59:00"),
      entry("09:59:30", runId),
      entry("10:01:00"),
      entry("10:04:00", runId),
    ];
    expect(resolveUnreadBoundaryIndex(entries, snapshot, loaded)).toBe(2);
  });

  it("falls back to the last answer of the run when it began before the visit", () => {
    // The answer was streaming when the user left; nothing newer exists.
    const entries = [entry("09:58:00"), entry("09:59:00", runId), entry("09:59:30", runId)];
    expect(resolveUnreadBoundaryIndex(entries, snapshot, loaded)).toBe(2);
  });

  it("places Mark unread above the final answer of the last run", () => {
    const markedUnread = { ...snapshot, visitedAt: "2026-06-20T10:04:59.999Z" };
    const entries = [entry("10:01:00"), entry("10:02:00", runId), entry("10:04:00", runId)];
    expect(resolveUnreadBoundaryIndex(entries, markedUnread, loaded)).toBe(2);
  });

  it("takes the earlier of the first new entry and the last answer", () => {
    // Work trailing the answer is new, but the answer it belongs to leads.
    const entries = [entry("09:58:00"), entry("09:59:00", runId), entry("10:02:00")];
    expect(resolveUnreadBoundaryIndex(entries, snapshot, loaded)).toBe(1);
  });

  it("ignores everything after the unread window", () => {
    const opened = [entry("09:58:00"), entry("10:01:00"), entry("10:04:00", runId)];
    const later = [...opened, entry("10:30:00"), entry("10:31:00", RunId.make("run-2"))];
    expect(resolveUnreadBoundaryIndex(opened, snapshot, loaded)).toBe(1);
    expect(resolveUnreadBoundaryIndex(later, snapshot, loaded)).toBe(1);
    // A thread with nothing to mark does not gain a boundary from a new prompt.
    const nothingNew = [entry("09:58:00"), entry("09:59:00")];
    expect(resolveUnreadBoundaryIndex(nothingNew, snapshot, loaded)).toBe(-1);
    expect(resolveUnreadBoundaryIndex([...nothingNew, entry("10:30:00")], snapshot, loaded)).toBe(
      -1,
    );
  });

  it("keeps the fallback on the answer the run had when it completed", () => {
    // The answer was streaming at the visit, so the fallback places the divider.
    const opened = [entry("09:58:00"), entry("09:59:00", runId)];
    expect(resolveUnreadBoundaryIndex(opened, snapshot, loaded)).toBe(1);
    // The same run appends another answer after the captured completion.
    const lateAnswer = [...opened, entry("10:20:00", runId)];
    expect(resolveUnreadBoundaryIndex(lateAnswer, snapshot, loaded)).toBe(1);
  });

  it("skips entries only this client has", () => {
    const entries = [entry("09:58:00"), null, entry("10:02:00")];
    expect(resolveUnreadBoundaryIndex(entries, snapshot, loaded)).toBe(2);
    expect(resolveUnreadBoundaryIndex([entry("09:58:00"), null], snapshot, loaded)).toBe(-1);
  });

  it("does not guess at the top of a partial history", () => {
    const page = [entry("10:02:00"), entry("10:04:00", runId)];
    expect(resolveUnreadBoundaryIndex(page, snapshot, { hasMoreHistory: true })).toBe(-1);
    // The older page holds the real boundary.
    const withOlderPage = [entry("09:58:00"), entry("10:01:00"), ...page];
    expect(resolveUnreadBoundaryIndex(withOlderPage, snapshot, { hasMoreHistory: true })).toBe(1);
    // With the whole history loaded, the first entry is a real boundary.
    expect(resolveUnreadBoundaryIndex(page, snapshot, loaded)).toBe(0);
  });
});
