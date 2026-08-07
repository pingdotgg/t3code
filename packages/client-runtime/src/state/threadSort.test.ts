import { describe, expect, it } from "vite-plus/test";
import type { PinnedThreadOrder } from "@t3tools/contracts";

import {
  pinnedThreadOrderForMove,
  pinnedThreadOrderUpdatesForMove,
  sortPinnedThreads,
  sortThreads,
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

describe("pinned thread ordering", () => {
  const pinned = [
    { id: "newest", createdAt: "2026-03-09T12:00:00.000Z" },
    { id: "middle", createdAt: "2026-03-09T11:00:00.000Z" },
    { id: "oldest", createdAt: "2026-03-09T10:00:00.000Z" },
  ] as const;

  it("keeps creation order until a synced order is assigned", () => {
    expect(sortPinnedThreads(pinned.toReversed()).map((thread) => thread.id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("moves one thread between neighbors without changing sibling values", () => {
    const order = pinnedThreadOrderForMove(pinned, "oldest", "middle");
    expect(order).not.toBeNull();
    expect(
      sortPinnedThreads(
        pinned.map((thread) =>
          thread.id === "oldest" ? { ...thread, pinnedOrder: order } : thread,
        ),
      ).map((thread) => thread.id),
    ).toEqual(["newest", "oldest", "middle"]);
  });

  it("can move to both list boundaries", () => {
    const topOrder = pinnedThreadOrderForMove(pinned, "oldest", "newest");
    const bottomOrder = pinnedThreadOrderForMove(pinned, "newest", "oldest");
    expect(
      sortPinnedThreads(
        pinned.map((thread) =>
          thread.id === "oldest" ? { ...thread, pinnedOrder: topOrder } : thread,
        ),
      ).map((thread) => thread.id),
    ).toEqual(["oldest", "newest", "middle"]);
    expect(
      sortPinnedThreads(
        pinned.map((thread) =>
          thread.id === "newest" ? { ...thread, pinnedOrder: bottomOrder } : thread,
        ),
      ).map((thread) => thread.id),
    ).toEqual(["middle", "oldest", "newest"]);
  });

  it("compacts the list before an order can exceed the wire limit", () => {
    const large = `6${"0".repeat(255)}`;
    const crowded = [
      {
        id: "left",
        createdAt: pinned[0].createdAt,
        pinnedOrder: `${large}/1` as PinnedThreadOrder,
      },
      {
        id: "right",
        createdAt: pinned[1].createdAt,
        pinnedOrder: `${BigInt(large) + 1n}/1` as PinnedThreadOrder,
      },
      { id: "moved", createdAt: pinned[2].createdAt },
    ];

    expect(pinnedThreadOrderForMove(crowded, "moved", "right")).toBeNull();
    const updates = pinnedThreadOrderUpdatesForMove(crowded, "moved", "right");
    expect(updates).toEqual([
      { threadId: "left", pinnedOrder: "1/1", previousPinnedOrder: `${large}/1` },
      {
        threadId: "moved",
        pinnedOrder: "2/1",
        previousPinnedOrder: expect.stringMatching(/^\d+\/1$/),
      },
      {
        threadId: "right",
        pinnedOrder: "3/1",
        previousPinnedOrder: `${BigInt(large) + 1n}/1`,
      },
    ]);
    expect(
      sortPinnedThreads(
        crowded.map((thread) => {
          const update = updates?.find((candidate) => candidate.threadId === thread.id);
          return update ? { ...thread, pinnedOrder: update.pinnedOrder } : thread;
        }),
      ).map((thread) => thread.id),
    ).toEqual(["left", "moved", "right"]);
  });

  it("compacts when duplicate neighbor positions leave no strict gap", () => {
    const duplicated = [
      { id: "a", createdAt: pinned[0].createdAt, pinnedOrder: "1/1" as PinnedThreadOrder },
      { id: "b", createdAt: pinned[1].createdAt, pinnedOrder: "1/1" as PinnedThreadOrder },
      { id: "c", createdAt: pinned[2].createdAt, pinnedOrder: "2/1" as PinnedThreadOrder },
    ];

    expect(pinnedThreadOrderForMove(duplicated, "c", "b")).toBeNull();
    const updates = pinnedThreadOrderUpdatesForMove(duplicated, "c", "b");
    expect(
      sortPinnedThreads(
        duplicated.map((thread) => {
          const update = updates?.find((candidate) => candidate.threadId === thread.id);
          return update ? { ...thread, pinnedOrder: update.pinnedOrder } : thread;
        }),
      ).map((thread) => thread.id),
    ).toEqual(["a", "c", "b"]);
  });

  it("breaks duplicate position ties independently of the client locale", () => {
    const duplicated = [
      { id: "ä", createdAt: pinned[0].createdAt, pinnedOrder: "1/1" as PinnedThreadOrder },
      { id: "z", createdAt: pinned[1].createdAt, pinnedOrder: "1/1" as PinnedThreadOrder },
    ];

    expect(sortPinnedThreads(duplicated).map((thread) => thread.id)).toEqual(["z", "ä"]);
  });
});
