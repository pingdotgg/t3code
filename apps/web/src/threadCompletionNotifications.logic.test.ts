import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadCompletionNotifications,
  NO_OBSERVED_THREADS,
  type ObservedThreads,
  type ThreadCompletionCandidate,
} from "./threadCompletionNotifications.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function thread(id: string, overrides: Partial<ThreadCompletionCandidate> = {}) {
  return {
    environmentId: ENVIRONMENT_ID,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${id}`,
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "completed",
      startedAt: "2026-01-01T00:04:00.000Z",
      completedAt: "2026-01-01T00:05:00.000Z",
    },
    session: { status: "idle", activeTurnId: null },
    ...overrides,
  } satisfies ThreadCompletionCandidate;
}

function running(id: string) {
  return thread(id, {
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "running",
      startedAt: "2026-01-01T00:04:00.000Z",
      completedAt: null,
    },
    session: { status: "running", activeTurnId: TurnId.make(`turn-${id}`) },
  });
}

function derive(threads: ReadonlyArray<ThreadCompletionCandidate>, observed: ObservedThreads) {
  return deriveThreadCompletionNotifications({ threads, observed });
}

describe("deriveThreadCompletionNotifications", () => {
  it("stays silent on threads it is seeing for the first time", () => {
    const result = derive([thread("a"), thread("b")], NO_OBSERVED_THREADS);

    expect(result.notifications).toEqual([]);
    expect(result.observed.size).toBe(2);
  });

  it("announces a turn that finishes while it is watching", () => {
    const seen = derive([running("a")], NO_OBSERVED_THREADS).observed;

    const result = derive([thread("a")], seen);

    expect(result.notifications).toEqual([
      {
        environmentId: ENVIRONMENT_ID,
        threadId: ThreadId.make("a"),
        projectId: ProjectId.make("project-1"),
        turnId: TurnId.make("turn-a"),
        title: "Thread a",
      },
    ]);
  });

  it("announces a thread once per turn, not once per snapshot", () => {
    const finished = derive([thread("a")], derive([running("a")], NO_OBSERVED_THREADS).observed);
    expect(finished.notifications).toHaveLength(1);

    expect(derive([thread("a")], finished.observed).notifications).toEqual([]);

    const nextTurn = derive(
      [
        thread("a", {
          latestTurn: {
            turnId: TurnId.make("turn-a2"),
            state: "completed",
            startedAt: "2026-01-01T00:06:00.000Z",
            completedAt: "2026-01-01T00:07:00.000Z",
          },
        }),
      ],
      finished.observed,
    );
    expect(nextTurn.notifications).toHaveLength(1);
  });

  it("stays silent when a thread reappears after dropping out of the snapshot", () => {
    const finished = derive([thread("a")], derive([running("a")], NO_OBSERVED_THREADS).observed);
    expect(finished.notifications).toHaveLength(1);

    const disconnected = derive([], finished.observed);
    expect(disconnected.observed.size).toBe(0);

    expect(derive([thread("a")], disconnected.observed).notifications).toEqual([]);
  });

  it("holds a settled turn back while delegated subagents are still working", () => {
    const seen = derive([running("a")], NO_OBSERVED_THREADS).observed;

    const working = derive([thread("a", { backgroundLiveness: "working" })], seen);
    expect(working.notifications).toEqual([]);

    const done = derive([thread("a", { backgroundLiveness: null })], working.observed);
    expect(done.notifications).toHaveLength(1);
  });

  it("announces a thread whose only live work is a watch loop", () => {
    const seen = derive([running("a")], NO_OBSERVED_THREADS).observed;

    const result = derive([thread("a", { backgroundLiveness: "monitoring" })], seen);

    expect(result.notifications).toHaveLength(1);
  });

  it("stays silent for turns that were interrupted or failed", () => {
    for (const state of ["interrupted", "error"] as const) {
      const seen = derive([running("a")], NO_OBSERVED_THREADS).observed;

      const result = derive(
        [
          thread("a", {
            latestTurn: {
              turnId: TurnId.make("turn-a"),
              state,
              startedAt: "2026-01-01T00:04:00.000Z",
              completedAt: "2026-01-01T00:05:00.000Z",
            },
          }),
        ],
        seen,
      );

      expect(result.notifications).toEqual([]);
    }
  });

  it("ignores archived threads entirely", () => {
    const seen = derive([running("a")], NO_OBSERVED_THREADS).observed;

    const result = derive([thread("a", { archivedAt: "2026-01-01T00:05:00.000Z" })], seen);

    expect(result.notifications).toEqual([]);
    expect(result.observed.size).toBe(0);
  });

  it("waits for the session to stop running before announcing", () => {
    const seen = derive([running("a")], NO_OBSERVED_THREADS).observed;

    const stillRunning = derive(
      [thread("a", { session: { status: "running", activeTurnId: TurnId.make("turn-a") } })],
      seen,
    );

    expect(stillRunning.notifications).toEqual([]);
  });
});
