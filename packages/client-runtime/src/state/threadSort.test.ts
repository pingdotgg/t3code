import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeOrderFloorKey,
  activeThreadSortKey,
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedReorder,
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortSettledThreads,
  sortThreads,
  type SettledThreadTimestampInput,
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
        latestRun: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to the latest activity when the stamp is missing or malformed", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "invalid",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestRun: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T11:00:00.000Z");
    expect(
      resolveSettledThreadTimestamp({
        settledAt: null,
        latestUserMessageAt: null,
        latestRun: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T12:00:00.000Z");
  });
});

describe("sortSettledThreads", () => {
  const settled = (input: {
    id: string;
    settledAt?: string | null;
    latestUserMessageAt?: string | null;
    latestRun?: SettledThreadTimestampInput["latestRun"];
    updatedAt?: string;
  }) => ({
    id: input.id,
    settledAt: input.settledAt ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    latestRun: input.latestRun ?? null,
    updatedAt: input.updatedAt ?? "2026-03-09T09:00:00.000Z",
  });

  it("counts a turn completion as activity for auto-settled threads", () => {
    const sorted = sortSettledThreads([
      settled({ id: "message-only", latestUserMessageAt: "2026-03-09T10:04:00.000Z" }),
      settled({
        id: "completed-later",
        latestUserMessageAt: "2026-03-09T10:00:00.000Z",
        latestRun: {
          runId: RunId.make("run-1"),
          status: "completed",
          assistantMessageId: null,
          requestedAt: "2026-03-09T10:00:00.000Z",
          startedAt: "2026-03-09T10:00:00.000Z",
          completedAt: "2026-03-09T10:30:00.000Z",
        },
      }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["completed-later", "message-only"]);
  });

  it("breaks timestamp ties by id so the order is stable", () => {
    const sorted = sortSettledThreads([
      settled({ id: "b", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "a", settledAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("sortThreads", () => {
  it.each(["created_at", "updated_at"] as const)(
    "preserves references, input order and descending id ties for %s",
    (sortOrder) => {
      const threads = Object.freeze([
        makeThread({ id: "a" }),
        makeThread({ id: "z" }),
        makeThread({ id: "invalid-a", createdAt: "invalid", updatedAt: "invalid" }),
        makeThread({ id: "invalid-z", createdAt: "invalid", updatedAt: "invalid" }),
      ]);
      const sorted = sortThreads(threads, sortOrder);
      expect(sorted).toEqual([threads[1], threads[0], threads[3], threads[2]]);
      expect(sorted[0]).toBe(threads[1]);
      expect(threads[0]?.id).toBe("a");
    },
  );

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

  it("orders last user message by what the user wrote, not agent messages in the user role", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "agent-posted",
          latestUserAuthoredMessageAt: "2026-03-09T10:00:00.000Z",
          latestUserMessageAt: "2026-03-09T10:30:00.000Z",
        }),
        makeThread({
          id: "user-wrote",
          latestUserAuthoredMessageAt: "2026-03-09T10:10:00.000Z",
          latestUserMessageAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["user-wrote", "agent-posted"]);
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

  it("places an arranged thread between unarranged ones without arranging them", () => {
    const newer = { id: "newer", createdAt: "2026-03-09T12:00:00.000Z" };
    const older = { id: "older", createdAt: "2026-03-09T10:00:00.000Z", unsettledAt: null };
    const arranged = {
      id: "arranged",
      createdAt: "2026-03-01T09:00:00.000Z",
      activeOrderKey: pinOrderKeyBetween(activeThreadSortKey(newer), activeThreadSortKey(older)),
    };
    const brandNew = { id: "brand-new", createdAt: "2026-03-10T09:00:00.000Z" };
    const saved = { id: "saved", createdAt: "2026-03-11T09:00:00.000Z", activeOrderKey: "b" };
    expect(
      sortActiveThreadsByOrderKey([saved, older, arranged, newer, brandNew]).map(
        (thread) => thread.id,
      ),
    ).toEqual(["brand-new", "newer", "arranged", "older", "saved"]);
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

describe("new threads above arranged ones", () => {
  type ActiveRow = {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null;
    readonly activeOrderKey?: string | null;
  };
  const at = (minute: number, ms = 0) =>
    `2026-11-20T10:${String(minute).padStart(2, "0")}:00.${String(ms).padStart(3, "0")}Z`;
  const ids = (rows: readonly ActiveRow[]) => sortActiveThreadsByOrderKey(rows).map((r) => r.id);
  // Moves one row the way a drop does: one write, keys from the shown order.
  const drop = (rows: readonly ActiveRow[], movedId: string, toIndex: number) => {
    const order = ids(rows).filter((id) => id !== movedId);
    order.splice(toIndex, 0, movedId);
    const assignments = planPinnedReorder({
      orderedIds: order,
      keysById: new Map(rows.map((row) => [row.id, activeThreadSortKey(row)])),
      movedId,
      floorKey: activeOrderFloorKey(rows),
    });
    expect(assignments.map((assignment) => assignment.id)).toEqual([movedId]);
    const keys = new Map(assignments.map((assignment) => [assignment.id, assignment.orderKey]));
    const moved = rows.map((row) =>
      keys.has(row.id) ? { ...row, activeOrderKey: keys.get(row.id)! } : row,
    );
    expect(ids(moved)).toEqual(order);
    return moved;
  };
  const a = { id: "a", createdAt: at(30) };
  const b = { id: "b", createdAt: at(20) };
  const c = { id: "c", createdAt: at(10) };

  it("puts a new thread above one dragged to the top", () => {
    const moved = drop([a, b], "b", 0);
    expect(ids(moved)).toEqual(["b", "a"]);
    // One millisecond after the newest thread is enough.
    const created = { id: "new", createdAt: at(30, 1) };
    expect(ids([...moved, created])).toEqual(["new", "b", "a"]);
  });

  it("puts a new thread above drops in the middle and at the bottom", () => {
    const created = { id: "new", createdAt: at(40) };
    expect(ids([...drop([a, b, c], "c", 1), created])).toEqual(["new", "a", "c", "b"]);
    expect(ids([...drop([a, b, c], "a", 2), created])).toEqual(["new", "b", "c", "a"]);
  });

  it("keeps the guarantee across repeated top drops and reopened threads", () => {
    let rows: readonly ActiveRow[] = [a, b, c];
    rows = drop(rows, "c", 0);
    rows = drop(rows, "b", 0);
    rows = drop(rows, "a", 1);
    expect(ids(rows)).toEqual(["b", "a", "c"]);
    const reopened = { id: "reopened", createdAt: at(0), unsettledAt: at(45) };
    expect(ids([...rows, { id: "new", createdAt: at(40) }, reopened])).toEqual([
      "reopened",
      "new",
      "b",
      "a",
      "c",
    ]);
  });

  it("keeps an older top key above new threads until that thread is moved", () => {
    // Before the floor, a top drop wrote a short key such as "0n".
    const legacy = { id: "legacy", createdAt: at(0), activeOrderKey: "0n" };
    const created = { id: "new", createdAt: at(40) };
    expect(ids([legacy, a, b, created])).toEqual(["legacy", "new", "a", "b"]);
    // A drop just below it still lands under later threads.
    expect(ids([...drop([legacy, a, b], "b", 1), created])).toEqual(["legacy", "new", "b", "a"]);
    // Moving it once writes a key that new threads pass.
    expect(ids([...drop([legacy, a, b], "legacy", 0), created])).toEqual([
      "new",
      "legacy",
      "a",
      "b",
    ]);
  });
});
