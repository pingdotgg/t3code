import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  countUnseenTaskbarCompletions,
  getTaskbarBadgeLabel,
} from "./DesktopTaskbarUnreadCoordinator";

const environmentId = "environment-1" as EnvironmentId;
const threadId = "thread-1" as ThreadId;
const threadKey = `${environmentId}:${threadId}`;

function completedThread(
  overrides: Partial<
    Pick<EnvironmentThreadShell, "archivedAt" | "environmentId" | "id" | "latestTurn">
  > = {},
) {
  return {
    environmentId,
    id: threadId,
    archivedAt: null,
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-09-09T12:00:00.000Z",
      startedAt: "2026-09-09T12:00:01.000Z",
      completedAt: "2026-09-09T12:00:10.000Z",
      assistantMessageId: null,
    },
    ...overrides,
  } as Pick<EnvironmentThreadShell, "archivedAt" | "environmentId" | "id" | "latestTurn">;
}

describe("hasUnseenTaskbarCompletion", () => {
  it("shows one digit and caps larger counts at 9+", () => {
    expect(getTaskbarBadgeLabel(1)).toBe("1");
    expect(getTaskbarBadgeLabel(9)).toBe("9");
    expect(getTaskbarBadgeLabel(10)).toBe("9+");
  });

  it("clears after the completed thread is visited", () => {
    const threads = [completedThread()];

    expect(
      countUnseenTaskbarCompletions(threads, {
        [threadKey]: "2026-09-09T12:00:05.000Z",
      }),
    ).toBe(1);
    expect(
      countUnseenTaskbarCompletions(threads, {
        [threadKey]: "2026-09-09T12:00:10.000Z",
      }),
    ).toBe(0);
  });

  it("stays visible until every unseen completion is visited", () => {
    const secondThreadId = "thread-2" as ThreadId;
    const threads = [completedThread(), completedThread({ id: secondThreadId })];

    expect(
      countUnseenTaskbarCompletions(threads, {
        [threadKey]: "2026-09-09T12:00:10.000Z",
        [`${environmentId}:${secondThreadId}`]: "2026-09-09T12:00:05.000Z",
      }),
    ).toBe(1);
  });

  it("ignores archived and never-visited historical threads", () => {
    expect(
      countUnseenTaskbarCompletions([completedThread({ archivedAt: "2026-09-09T12:01:00.000Z" })], {
        [threadKey]: "2026-09-09T12:00:05.000Z",
      }),
    ).toBe(0);
    expect(countUnseenTaskbarCompletions([completedThread()], {})).toBe(0);
  });
});
