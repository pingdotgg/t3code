import { describe, expect, it } from "vite-plus/test";

import {
  sortSettledThreadsForListV2,
  sortThreads,
  sortThreadsForListV2,
  threadListV2Priority,
  type ThreadListV2Priority,
  type ThreadSortInput,
} from "./threadSort.ts";

type TestThread = { readonly id: string } & ThreadSortInput;

function makeThread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "thread-1",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    messages: [],
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("sortThreads", () => {
  it("falls back to updatedAt and createdAt when latestUserMessageAt is invalid and there are no messages", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "not-a-date",
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: "thread-2",
          latestUserMessageAt: "still-not-a-date",
          createdAt: "invalid-created-at",
          updatedAt: "invalid-updated-at",
        }),
        makeThread({
          id: "thread-3",
          latestUserMessageAt: "invalid-latest-user-message-at",
          createdAt: "2026-03-09T10:06:00.000Z",
          updatedAt: "invalid-updated-at",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-3", "thread-1", "thread-2"]);
  });

  it("falls back to the latest valid user message when latestUserMessageAt is invalid", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "invalid-latest-user-message-at",
          updatedAt: "2026-03-09T10:00:00.000Z",
          messages: [
            { role: "user", createdAt: "2026-03-09T10:05:00.000Z" },
            { role: "assistant", createdAt: "2026-03-09T10:30:00.000Z" },
            { role: "user", createdAt: "2026-03-09T10:20:00.000Z" },
          ],
        }),
        makeThread({
          id: "thread-2",
          createdAt: "2026-03-09T10:15:00.000Z",
          updatedAt: "2026-03-09T10:15:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
  });
});

describe("sortThreadsForListV2", () => {
  const threads = [
    { id: "oldest", createdAt: "2026-06-01T08:00:00.000Z" },
    { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
    { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
  ] as const;

  it("orders by creation time within the default priority", () => {
    expect(sortThreadsForListV2(threads).map((thread) => thread.id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("ranks server-backed wakes and manual un-settles above default threads", () => {
    const priorityById: Record<string, ThreadListV2Priority> = {
      oldest: "woke",
      middle: "unsettled",
      newest: "default",
    };
    expect(
      sortThreadsForListV2(threads, (thread) => priorityById[thread.id] ?? "default").map(
        (thread) => thread.id,
      ),
    ).toEqual(["oldest", "middle", "newest"]);
  });

  it("breaks equal creation timestamps by id", () => {
    const tied = [
      { id: "b", createdAt: "2026-06-01T10:00:00.000Z" },
      { id: "a", createdAt: "2026-06-01T10:00:00.000Z" },
    ];
    expect(sortThreadsForListV2(tied).map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("threadListV2Priority", () => {
  it("lets a manual un-settle consume older wake priority", () => {
    expect(
      threadListV2Priority({ settledOverride: "active" }, { wokeAt: "2026-06-01T10:00:00.000Z" }),
    ).toBe("unsettled");
    expect(threadListV2Priority({ settledOverride: "active" }, { wokeAt: null })).toBe("unsettled");
    expect(
      threadListV2Priority({ settledOverride: null }, { wokeAt: "2026-06-01T10:00:00.000Z" }),
    ).toBe("woke");
    expect(threadListV2Priority({ settledOverride: null }, { wokeAt: null })).toBe("default");
  });
});

describe("sortSettledThreadsForListV2", () => {
  const settled = (input: {
    id: string;
    settledAt?: string | null;
    latestUserMessageAt?: string | null;
    completedAt?: string | null;
    updatedAt?: string;
  }) => ({
    id: input.id,
    settledAt: input.settledAt ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    latestTurn:
      input.completedAt === undefined
        ? null
        : {
            requestedAt: "2026-03-09T10:00:00.000Z",
            startedAt: "2026-03-09T10:00:00.000Z",
            completedAt: input.completedAt,
          },
    updatedAt: input.updatedAt ?? "2026-03-09T09:00:00.000Z",
  });

  it("orders by settle time and falls back to the latest activity", () => {
    const sorted = sortSettledThreadsForListV2([
      settled({ id: "explicit", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "message", latestUserMessageAt: "2026-03-09T11:00:00.000Z" }),
      settled({ id: "completed", completedAt: "2026-03-09T12:00:00.000Z" }),
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["completed", "message", "explicit"]);
  });

  it("breaks timestamp ties by id", () => {
    const sorted = sortSettledThreadsForListV2([
      settled({ id: "b", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "a", settledAt: "2026-03-09T10:00:00.000Z" }),
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});
