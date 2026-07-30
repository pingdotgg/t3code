import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { markThreadVisited, resolveOpenThreadVisitedAt } from "./thread-visits.logic";

describe("markThreadVisited", () => {
  it("keeps the newest valid visit timestamp", () => {
    const initial = { thread: "2026-06-01T12:00:00.000Z" };
    expect(markThreadVisited(initial, "thread", "2026-06-01T11:59:00.000Z")).toBe(initial);
    expect(markThreadVisited(initial, "thread", "invalid")).toBe(initial);
    expect(markThreadVisited(initial, "thread", "2026-06-01T12:01:00.000Z")).toEqual({
      thread: "2026-06-01T12:01:00.000Z",
    });
  });
});

describe("resolveOpenThreadVisitedAt", () => {
  it("advances from the running turn start to its completion", () => {
    const thread = {
      createdAt: "2026-06-01T11:00:00.000Z",
      updatedAt: "2026-06-01T12:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-06-01T12:01:00.000Z",
        startedAt: "2026-06-01T12:01:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    } satisfies Pick<EnvironmentThreadShell, "createdAt" | "latestTurn" | "updatedAt">;

    expect(resolveOpenThreadVisitedAt(thread)).toBe("2026-06-01T12:01:01.000Z");
    expect(
      resolveOpenThreadVisitedAt({
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          state: "completed",
          completedAt: "2026-06-01T12:02:00.000Z",
        },
      }),
    ).toBe("2026-06-01T12:02:00.000Z");
  });
});
