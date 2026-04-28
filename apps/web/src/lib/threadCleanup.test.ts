import { EnvironmentId, ProjectId, ThreadId } from "@forma/contracts";
import { describe, expect, it } from "vitest";
import type { SidebarThreadSummary } from "../types";
import {
  bucketThreadsForCleanup,
  isThreadStaleForCleanup,
  resolveThreadCleanupActivityAt,
} from "./threadCleanup";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");

function makeThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-01T12:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: "2026-04-01T18:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    queuedTurnCount: 0,
    turnQueueStatus: "idle",
    ...overrides,
  };
}

describe("resolveThreadCleanupActivityAt", () => {
  it("prefers latest user message over updatedAt and createdAt", () => {
    expect(
      resolveThreadCleanupActivityAt(
        makeThread("thread-user", {
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T12:00:00.000Z",
          latestUserMessageAt: "2026-04-01T18:00:00.000Z",
        }),
      ),
    ).toBe("2026-04-01T18:00:00.000Z");
  });

  it("falls back to updatedAt when latestUserMessageAt is missing", () => {
    expect(
      resolveThreadCleanupActivityAt(
        makeThread("thread-updated", {
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T12:00:00.000Z",
          latestUserMessageAt: null,
        }),
      ),
    ).toBe("2026-04-01T12:00:00.000Z");
  });

  it("falls back to createdAt when both newer timestamps are missing", () => {
    expect(
      resolveThreadCleanupActivityAt(
        makeThread("thread-created", {
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: undefined,
          latestUserMessageAt: null,
        }),
      ),
    ).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("isThreadStaleForCleanup", () => {
  it("uses a strict cutoff", () => {
    expect(
      isThreadStaleForCleanup({
        thread: makeThread("thread-cutoff", {
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
        }),
        inactiveDays: 1,
        now: Date.parse("2026-04-02T00:00:00.000Z"),
      }),
    ).toBe(false);
  });
});

describe("bucketThreadsForCleanup", () => {
  it("ignores archived threads", () => {
    const buckets = bucketThreadsForCleanup({
      threads: [
        makeThread("thread-archived", {
          archivedAt: "2026-04-03T00:00:00.000Z",
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
        }),
      ],
      inactiveDays: 1,
      now: Date.parse("2026-04-03T00:00:00.000Z"),
    });

    expect(buckets).toEqual({
      eligible: [],
      skippedQueued: [],
      skippedRunning: [],
    });
  });

  it("classifies stale running and queued threads separately", () => {
    const buckets = bucketThreadsForCleanup({
      threads: [
        makeThread("thread-running", {
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
          session: {
            provider: "codex",
            status: "running",
            activeTurnId: "turn-1" as never,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
            orchestrationStatus: "running",
          },
        }),
        makeThread("thread-queued", {
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
          queuedTurnCount: 2,
          turnQueueStatus: "queued",
        }),
      ],
      inactiveDays: 1,
      now: Date.parse("2026-04-03T00:00:00.000Z"),
    });

    expect(buckets.eligible).toEqual([]);
    expect(buckets.skippedRunning.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-running"),
    ]);
    expect(buckets.skippedQueued.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-queued"),
    ]);
  });

  it("returns eligible stale threads oldest first", () => {
    const buckets = bucketThreadsForCleanup({
      threads: [
        makeThread("thread-newer", {
          latestUserMessageAt: "2026-04-01T12:00:00.000Z",
        }),
        makeThread("thread-older", {
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
        }),
      ],
      inactiveDays: 1,
      now: Date.parse("2026-04-03T00:00:00.000Z"),
    });

    expect(buckets.eligible.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-older"),
      ThreadId.make("thread-newer"),
    ]);
  });
});
