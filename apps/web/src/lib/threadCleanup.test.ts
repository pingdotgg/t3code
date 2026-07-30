import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadCleanupThread } from "./threadCleanup";
import {
  bucketThreadsForCleanup,
  isThreadStaleForCleanup,
  resolveThreadCleanupActivityAt,
} from "./threadCleanup";

function makeThread(id: string, overrides: Partial<ThreadCleanupThread> = {}): ThreadCleanupThread {
  return {
    id: ThreadId.make(id),
    session: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-01T12:00:00.000Z",
    latestUserMessageAt: "2026-04-01T18:00:00.000Z",
    queuedTurnCount: 0,
    ...overrides,
  };
}

describe("resolveThreadCleanupActivityAt", () => {
  it("prefers the latest user message and falls back through thread timestamps", () => {
    const { updatedAt: _updatedAt, ...createdThread } = makeThread("created", {
      latestUserMessageAt: null,
    });
    expect(resolveThreadCleanupActivityAt(makeThread("user"))).toBe("2026-04-01T18:00:00.000Z");
    expect(
      resolveThreadCleanupActivityAt(makeThread("updated", { latestUserMessageAt: null })),
    ).toBe("2026-04-01T12:00:00.000Z");
    expect(resolveThreadCleanupActivityAt(createdThread)).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("isThreadStaleForCleanup", () => {
  it("uses a strict cutoff", () => {
    expect(
      isThreadStaleForCleanup({
        thread: makeThread("cutoff", {
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
        }),
        inactiveDays: 1,
        now: Date.parse("2026-04-02T00:00:00.000Z"),
      }),
    ).toBe(false);
  });
});

describe("bucketThreadsForCleanup", () => {
  it("ignores archived threads and returns eligible threads oldest first", () => {
    const buckets = bucketThreadsForCleanup({
      threads: [
        makeThread("newer", { latestUserMessageAt: "2026-04-01T12:00:00.000Z" }),
        makeThread("archived", {
          archivedAt: "2026-04-03T00:00:00.000Z",
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
        }),
        makeThread("older", { latestUserMessageAt: "2026-04-01T00:00:00.000Z" }),
      ],
      inactiveDays: 1,
      now: Date.parse("2026-04-03T00:00:00.000Z"),
    });

    expect(buckets.eligible.map((thread) => thread.id)).toEqual([
      ThreadId.make("older"),
      ThreadId.make("newer"),
    ]);
    expect(buckets.skippedQueued).toEqual([]);
    expect(buckets.skippedRunning).toEqual([]);
  });

  it("classifies stale queued threads separately", () => {
    const buckets = bucketThreadsForCleanup({
      threads: [
        makeThread("queued", {
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
          queuedTurnCount: 2,
        }),
      ],
      inactiveDays: 1,
      now: Date.parse("2026-04-03T00:00:00.000Z"),
    });

    expect(buckets.eligible).toEqual([]);
    expect(buckets.skippedQueued.map((thread) => thread.id)).toEqual([ThreadId.make("queued")]);
  });
});
