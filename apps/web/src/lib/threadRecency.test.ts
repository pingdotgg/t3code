import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  compareThreadsForSidebar,
  getLatestUserMessageAt,
  getThreadSidebarRecency,
} from "./threadRecency";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-10T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("threadRecency", () => {
  it("returns the latest user message timestamp", () => {
    const thread = makeThread({
      messages: [
        {
          id: "assistant-1" as never,
          role: "assistant",
          text: "assistant",
          createdAt: "2026-03-10T10:10:00.000Z",
          streaming: false,
        },
        {
          id: "user-1" as never,
          role: "user",
          text: "first",
          createdAt: "2026-03-10T10:05:00.000Z",
          streaming: false,
        },
        {
          id: "user-2" as never,
          role: "user",
          text: "latest",
          createdAt: "2026-03-10T10:15:00.000Z",
          streaming: false,
        },
      ],
    });

    expect(getLatestUserMessageAt(thread)).toBe("2026-03-10T10:15:00.000Z");
  });

  it("ignores assistant-only activity when deriving recency", () => {
    const thread = makeThread({
      messages: [
        {
          id: "assistant-1" as never,
          role: "assistant",
          text: "assistant",
          createdAt: "2026-03-10T10:20:00.000Z",
          streaming: false,
        },
      ],
    });

    expect(getThreadSidebarRecency(thread)).toBe("2026-03-10T10:00:00.000Z");
  });

  it("prefers optimistic recency over confirmed user-message recency", () => {
    const thread = makeThread({
      messages: [
        {
          id: "user-1" as never,
          role: "user",
          text: "first",
          createdAt: "2026-03-10T10:05:00.000Z",
          streaming: false,
        },
      ],
    });

    expect(getThreadSidebarRecency(thread, "2026-03-10T10:06:00.000Z")).toBe(
      "2026-03-10T10:06:00.000Z",
    );
  });

  it("does not allow an older optimistic timestamp to lower confirmed recency", () => {
    const thread = makeThread({
      messages: [
        {
          id: "user-1" as never,
          role: "user",
          text: "newest",
          createdAt: "2026-03-10T10:07:00.000Z",
          streaming: false,
        },
      ],
    });

    expect(getThreadSidebarRecency(thread, "2026-03-10T10:06:00.000Z")).toBe(
      "2026-03-10T10:07:00.000Z",
    );
  });

  it("sorts by sidebar recency with deterministic tiebreakers", () => {
    const optimisticThread = makeThread({
      id: ThreadId.makeUnsafe("thread-optimistic"),
      createdAt: "2026-03-10T09:00:00.000Z",
      messages: [
        {
          id: "user-1" as never,
          role: "user",
          text: "older",
          createdAt: "2026-03-10T10:01:00.000Z",
          streaming: false,
        },
      ],
    });
    const newerCreatedThread = makeThread({
      id: ThreadId.makeUnsafe("thread-newer-created"),
      createdAt: "2026-03-10T10:00:00.000Z",
      messages: [
        {
          id: "user-2" as never,
          role: "user",
          text: "same time",
          createdAt: "2026-03-10T10:02:00.000Z",
          streaming: false,
        },
      ],
    });
    const olderCreatedThread = makeThread({
      id: ThreadId.makeUnsafe("thread-older-created"),
      createdAt: "2026-03-10T08:00:00.000Z",
      messages: [
        {
          id: "user-3" as never,
          role: "user",
          text: "same time",
          createdAt: "2026-03-10T10:02:00.000Z",
          streaming: false,
        },
      ],
    });

    const ordered = [olderCreatedThread, newerCreatedThread, optimisticThread].toSorted((a, b) =>
      compareThreadsForSidebar(a, b, {
        [optimisticThread.id]: "2026-03-10T10:03:00.000Z",
      }),
    );

    expect(ordered.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-optimistic"),
      ThreadId.makeUnsafe("thread-newer-created"),
      ThreadId.makeUnsafe("thread-older-created"),
    ]);
  });
});
