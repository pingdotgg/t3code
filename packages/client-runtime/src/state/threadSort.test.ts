import { describe, expect, it } from "vite-plus/test";

import {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedMove,
  planPinnedReorder,
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
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

describe("resolveSettledThreadTimestamp", () => {
  it("prefers the persisted settlement stamp over later activity", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "2026-03-09T10:00:00.000Z",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to the latest activity when the stamp is missing or malformed", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "invalid",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T11:00:00.000Z");
    expect(
      resolveSettledThreadTimestamp({
        settledAt: null,
        latestUserMessageAt: null,
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T12:00:00.000Z");
  });
});

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

describe("planPinnedReorder with hidden rows", () => {
  it("keeps hidden slots available when inserting between visible neighbors", () => {
    const midpoint = pinOrderKeyBetween("f", "t")!;
    const keysById = new Map([
      ["a", "f"],
      ["b", "t"],
      ["moved", "z"],
      ["snoozed", midpoint],
    ]);
    const assignments = planPinnedReorder({
      orderedIds: ["a", "moved", "b"],
      keysById,
      movedId: "moved",
    });
    expect(assignments).toHaveLength(1);
    const key = assignments[0]!.orderKey;
    expect(key > "f" && key < "t").toBe(true);
    expect(key).not.toBe(midpoint);
    expect(assignments[0]!.id).toBe("moved");
  });

  it("materializes keyless rows without overwriting hidden slots", () => {
    const reserved = generateSpreadPinOrderKeys(6);
    const keysById = new Map<string, string | null>([
      ["a", null],
      ["b", null],
      ["c", null],
      ...reserved.map((key, i) => [`hidden-${i}`, key] as const),
    ]);
    const assignments = planPinnedReorder({ orderedIds: ["c", "a", "b"], keysById, movedId: "c" });
    expect(assignments.map(({ id }) => id)).toEqual(["c", "a", "b"]);
    const keys = assignments.map(({ orderKey }) => orderKey);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((key) => !reserved.includes(key))).toBe(true);
  });
});

describe("planPinnedMove", () => {
  it("moves a thread up with a single key write", () => {
    const assignments = planPinnedMove({
      orderedIds: ["a", "b", "c"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
        ["c", "t"],
      ]),
      movedId: "c",
      direction: "up",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe("c");
    expect(assignments![0]!.orderKey > "f" && assignments![0]!.orderKey < "m").toBe(true);
  });

  it("returns null when the move falls off the end of the list", () => {
    const input = {
      orderedIds: ["a", "b"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
      ]),
    };
    expect(planPinnedMove({ ...input, movedId: "a", direction: "up" })).toBeNull();
    expect(planPinnedMove({ ...input, movedId: "b", direction: "down" })).toBeNull();
  });

  it("materializes keys for the whole section when a neighbor is keyless", () => {
    const assignments = planPinnedMove({
      orderedIds: ["a", "b", "c"],
      keysById: new Map([
        ["a", null],
        ["b", "m"],
        ["c", null],
      ]),
      movedId: "b",
      direction: "up",
    });
    expect(assignments).not.toBeNull();
    const keys = assignments!.map((entry) => entry.orderKey);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("sortPinnedThreadsByOrderKey", () => {
  it("breaks equal keys by id THEN environment so merged lists are stable everywhere", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      {
        id: "thread-1",
        createdAt: "2026-03-09T10:00:00.000Z",
        pinOrderKey: "m",
        environmentId: "env-b",
      },
      {
        id: "thread-1",
        createdAt: "2026-03-09T11:00:00.000Z",
        pinOrderKey: "m",
        environmentId: "env-a",
      },
    ]);
    expect(sorted.map((thread) => thread.environmentId)).toEqual(["env-a", "env-b"]);
  });
});

describe("generateSpreadPinOrderKeys", () => {
  it.each([0, 1, 650, 675, 676, 1_001, 2_000])(
    "leaves unique, insertable keys for %i threads",
    (count) => {
      const keys = generateSpreadPinOrderKeys(count);
      expect(keys).toHaveLength(count);
      expect(new Set(keys).size).toBe(count);
      expect([...keys].sort()).toEqual(keys);
      for (let index = 0; index < keys.length; index += 1) {
        const before = keys[index - 1] ?? null;
        const after = keys[index]!;
        expect(after).toMatch(/^[a-z]*[b-z]$/);
        const between = pinOrderKeyBetween(before, after);
        expect(between).not.toBeNull();
        expect(between! < after).toBe(true);
        if (before !== null) expect(between! > before).toBe(true);
      }
    },
  );
});

describe("sortActiveThreadsByOrderKey", () => {
  it("keeps new and reopened threads ahead of the saved order", () => {
    const sorted = sortActiveThreadsByOrderKey([
      {
        id: "arranged-first",
        createdAt: "2026-03-09T09:00:00.000Z",
        activeOrderKey: "f",
      },
      {
        id: "new",
        createdAt: "2026-03-09T11:00:00.000Z",
        activeOrderKey: null,
      },
      {
        id: "arranged-last",
        createdAt: "2026-03-09T12:00:00.000Z",
        unsettledAt: "2026-03-09T13:00:00.000Z",
        activeOrderKey: "t",
      },
      {
        id: "reopened",
        createdAt: "2026-03-01T09:00:00.000Z",
        unsettledAt: "2026-03-09T12:00:00.000Z",
      },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual([
      "reopened",
      "new",
      "arranged-first",
      "arranged-last",
    ]);
  });

  it("breaks equal order keys and timestamps by thread then environment", () => {
    for (const activeOrderKey of [null, "m"]) {
      const threads = [
        { id: "thread-b", environmentId: "env-a" },
        { id: "thread-a", environmentId: "env-b" },
        { id: "thread-a", environmentId: "env-a" },
      ].map((thread) => ({
        ...thread,
        createdAt: "2026-03-09T10:00:00.000Z",
        activeOrderKey,
      }));
      expect(
        sortActiveThreadsByOrderKey(threads).map(
          (thread) => `${thread.id}:${thread.environmentId}`,
        ),
      ).toEqual(["thread-a:env-a", "thread-a:env-b", "thread-b:env-a"]);
    }
  });

  it("applies every move across a mixed keyless and keyed section", () => {
    const threads = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      createdAt: `2026-03-09T0${6 - index}:00:00.000Z`,
      activeOrderKey: index < 3 ? null : ["f", "m", "t"][index - 3]!,
    }));
    const ids = threads.map((thread) => thread.id);
    const keysById = new Map(threads.map((thread) => [thread.id, thread.activeOrderKey]));
    for (const movedId of ids) {
      for (let targetIndex = 0; targetIndex < ids.length; targetIndex += 1) {
        const desired = ids.filter((id) => id !== movedId);
        desired.splice(targetIndex, 0, movedId);
        const assignments = planPinnedReorder({ orderedIds: desired, keysById, movedId });
        const nextKeys = new Map(
          assignments.map((assignment) => [assignment.id, assignment.orderKey]),
        );
        const updated = threads.map((thread) => ({
          ...thread,
          activeOrderKey: nextKeys.get(thread.id) ?? thread.activeOrderKey,
        }));
        expect(sortActiveThreadsByOrderKey(updated).map((thread) => thread.id)).toEqual(desired);
      }
    }
  });

  it("moves a keyless thread into the arranged run with one write", () => {
    const assignments = planPinnedMove({
      orderedIds: ["new", "reopened", "first", "last"],
      keysById: new Map([
        ["new", null],
        ["reopened", null],
        ["first", "f"],
        ["last", "t"],
      ]),
      movedId: "reopened",
      direction: "down",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe("reopened");
    expect(assignments![0]!.orderKey > "f").toBe(true);
    expect(assignments![0]!.orderKey < "t").toBe(true);
  });

  it("materializes a large active list without changing the requested order", () => {
    const threads = Array.from({ length: 1_200 }, (_, index) => ({
      id: String(index),
      createdAt: "2026-03-09T10:00:00.000Z",
      activeOrderKey: null as string | null,
    }));
    const orderedIds = threads.map((thread) => thread.id).toReversed();
    const assignments = planPinnedReorder({
      orderedIds,
      movedId: orderedIds[0]!,
      keysById: new Map(threads.map((thread) => [thread.id, thread.activeOrderKey])),
    });
    const keys = new Map(assignments.map((assignment) => [assignment.id, assignment.orderKey]));
    const updated = threads.map((thread) => ({ ...thread, activeOrderKey: keys.get(thread.id) }));
    expect(sortActiveThreadsByOrderKey(updated).map((thread) => thread.id)).toEqual(orderedIds);
  });
});
