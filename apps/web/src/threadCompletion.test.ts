import { describe, expect, it } from "vitest";
import { EnvironmentId, ThreadId, type OrchestrationLatestTurn } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";

import { countUnseenCompletedThreads, hasUnseenCompletion } from "./threadCompletion";

function makeLatestTurn(completedAt: string | null): Pick<OrchestrationLatestTurn, "completedAt"> {
  return { completedAt };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a completion is newer than the last visit", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn("2026-06-12T12:00:00.000Z"),
        lastVisitedAt: "2026-06-12T11:59:59.000Z",
      }),
    ).toBe(true);
  });

  it("returns false when the thread has been visited at the completion time", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn("2026-06-12T12:00:00.000Z"),
        lastVisitedAt: "2026-06-12T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("ignores missing and malformed completion timestamps", () => {
    expect(hasUnseenCompletion({ latestTurn: null })).toBe(false);
    expect(hasUnseenCompletion({ latestTurn: makeLatestTurn(null) })).toBe(false);
    expect(hasUnseenCompletion({ latestTurn: makeLatestTurn("not-a-date") })).toBe(false);
  });
});

describe("countUnseenCompletedThreads", () => {
  it("counts unarchived unseen completed threads by scoped thread key", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const seenThreadId = ThreadId.make("thread-seen");
    const unseenThreadId = ThreadId.make("thread-unseen");
    const archivedThreadId = ThreadId.make("thread-archived");

    expect(
      countUnseenCompletedThreads(
        [
          {
            id: seenThreadId,
            environmentId,
            archivedAt: null,
            latestTurn: makeLatestTurn("2026-06-12T12:00:00.000Z"),
          },
          {
            id: unseenThreadId,
            environmentId,
            archivedAt: null,
            latestTurn: makeLatestTurn("2026-06-12T12:05:00.000Z"),
          },
          {
            id: archivedThreadId,
            environmentId,
            archivedAt: "2026-06-12T12:06:00.000Z",
            latestTurn: makeLatestTurn("2026-06-12T12:06:00.000Z"),
          },
        ],
        {
          [scopedThreadKey(scopeThreadRef(environmentId, seenThreadId))]:
            "2026-06-12T12:00:00.000Z",
          [scopedThreadKey(scopeThreadRef(environmentId, unseenThreadId))]:
            "2026-06-12T12:04:59.000Z",
        },
      ),
    ).toBe(1);
  });
});
