import { describe, expect, it } from "vite-plus/test";
import {
  WorkspaceMutationFold,
  latestWorkspaceMutationId,
  retainedTurnIdsAfterRevert,
  workspaceMutationItemType,
  type WorkspaceMutationActivityLike,
} from "./workspaceMutations.ts";

let next = 0;
function activity(input: {
  readonly kind?: string;
  readonly itemType?: string;
  readonly status?: string;
  readonly turnId?: string | null;
  readonly sequence?: number;
  readonly id?: string;
}): WorkspaceMutationActivityLike {
  next += 1;
  return {
    id: input.id ?? `activity-${next}`,
    kind: input.kind ?? "tool.completed",
    payload: {
      ...(input.itemType === undefined ? {} : { itemType: input.itemType }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    turnId: input.turnId ?? null,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    createdAt: `2026-09-13T00:00:${String(next).padStart(2, "0")}.000Z`,
  };
}

describe("workspaceMutationItemType", () => {
  it("qualifies completed command_execution and file_change rows", () => {
    expect(workspaceMutationItemType(activity({ itemType: "command_execution" }))).toBe(
      "command_execution",
    );
    expect(workspaceMutationItemType(activity({ itemType: "file_change" }))).toBe("file_change");
  });
  it("qualifies terminal tool.updated rows and skips in-progress updates", () => {
    expect(
      workspaceMutationItemType(
        activity({ kind: "tool.updated", itemType: "file_change", status: "completed" }),
      ),
    ).toBe("file_change");
    expect(
      workspaceMutationItemType(
        activity({ kind: "tool.updated", itemType: "file_change", status: "inProgress" }),
      ),
    ).toBeNull();
    expect(
      workspaceMutationItemType(
        activity({ kind: "tool.updated", itemType: "file_change", status: "in_progress" }),
      ),
    ).toBeNull();
  });
  it("skips unrelated item types, kinds, and missing payloads", () => {
    expect(workspaceMutationItemType(activity({ itemType: "message" }))).toBeNull();
    expect(
      workspaceMutationItemType(activity({ kind: "turn.started", itemType: "file_change" })),
    ).toBeNull();
    expect(workspaceMutationItemType({ kind: "tool.completed", payload: null })).toBeNull();
    expect(workspaceMutationItemType({ kind: "tool.completed", payload: 42 })).toBeNull();
  });
});

describe("latestWorkspaceMutationId", () => {
  it("returns the newest qualifying activity in canonical order", () => {
    const list = [
      activity({ itemType: "file_change", id: "a" }),
      activity({ itemType: "message", id: "b" }),
      activity({
        kind: "tool.updated",
        itemType: "command_execution",
        status: "completed",
        id: "c",
      }),
    ];
    expect(latestWorkspaceMutationId(list)).toBe("c");
    expect(latestWorkspaceMutationId(list.slice(0, 1))).toBe("a");
    expect(latestWorkspaceMutationId([activity({ itemType: "message" })])).toBeNull();
    expect(latestWorkspaceMutationId([])).toBeNull();
  });
});

describe("WorkspaceMutationFold", () => {
  it("moves latest forward only on qualifying appends", () => {
    const fold = new WorkspaceMutationFold();
    expect(fold.latestId).toBeNull();
    expect(fold.applyActivity(activity({ itemType: "message", id: "m" }))).toBe(false);
    expect(fold.latestId).toBeNull();
    expect(fold.applyActivity(activity({ itemType: "file_change", id: "f1" }))).toBe(true);
    expect(fold.latestId).toBe("f1");
    expect(fold.latestItemType).toBe("file_change");
    expect(
      fold.applyActivity(
        activity({
          kind: "tool.updated",
          itemType: "command_execution",
          status: "inProgress",
          id: "u",
        }),
      ),
    ).toBe(false);
    expect(fold.latestId).toBe("f1");
    expect(
      fold.applyActivity(
        activity({
          kind: "tool.updated",
          itemType: "command_execution",
          status: "completed",
          id: "u",
        }),
      ),
    ).toBe(true);
    expect(fold.latestId).toBe("u");
    expect(fold.latestItemType).toBe("command_execution");
  });
  it("does not move latest when an older row upserts", () => {
    const fold = new WorkspaceMutationFold();
    fold.applyActivity(activity({ itemType: "file_change", id: "new", sequence: 9 }));
    expect(
      fold.applyActivity(activity({ itemType: "command_execution", id: "old", sequence: 1 })),
    ).toBe(false);
    expect(fold.latestId).toBe("new");
  });
  it("seeds pick the canonical newest row regardless of input order or duplicates", () => {
    const fold = new WorkspaceMutationFold();
    fold.seed(
      [
        activity({ itemType: "file_change", id: "z-newest", sequence: 9 }),
        activity({ itemType: "command_execution", id: "a-oldest", sequence: 1 }),
        activity({ itemType: "file_change", id: "z-newest", sequence: 9 }),
        activity({ itemType: "message", id: "unrelated", sequence: 20 }),
      ],
      [],
    );
    expect(fold.latestId).toBe("z-newest");
    expect(fold.latestItemType).toBe("file_change");
  });
  it("falls back to the surviving newest row when the latest stops qualifying", () => {
    const fold = new WorkspaceMutationFold();
    fold.applyActivity(activity({ itemType: "file_change", id: "a", sequence: 1 }));
    fold.applyActivity(activity({ itemType: "command_execution", id: "b", sequence: 2 }));
    expect(
      fold.applyActivity(
        activity({
          kind: "tool.updated",
          itemType: "command_execution",
          status: "inProgress",
          id: "b",
          sequence: 2,
        }),
      ),
    ).toBe(true);
    expect(fold.latestId).toBe("a");
  });
  it("re-scans when the latest row's own upsert moves its order key", () => {
    const fold = new WorkspaceMutationFold();
    fold.applyActivity(activity({ itemType: "file_change", id: "a", sequence: 5 }));
    fold.applyActivity(activity({ itemType: "command_execution", id: "b", sequence: 9 }));
    expect(
      fold.applyActivity(activity({ itemType: "command_execution", id: "b", sequence: 1 })),
    ).toBe(true);
    expect(fold.latestId).toBe("a");
  });
  it("ignores removal of rows below the latest", () => {
    const fold = new WorkspaceMutationFold();
    fold.applyActivity(activity({ itemType: "file_change", id: "a", sequence: 1 }));
    fold.applyActivity(activity({ itemType: "command_execution", id: "b", sequence: 2 }));
    expect(
      fold.applyActivity(
        activity({
          kind: "tool.updated",
          itemType: "file_change",
          status: "inProgress",
          id: "a",
          sequence: 1,
        }),
      ),
    ).toBe(false);
    expect(fold.latestId).toBe("b");
  });
  it("drops reverted turns and moves latest back", () => {
    const fold = new WorkspaceMutationFold();
    fold.seed(
      [
        activity({ itemType: "file_change", id: "a", turnId: "turn-1" }),
        activity({ itemType: "command_execution", id: "b", turnId: "turn-2" }),
      ],
      [
        { turnId: "turn-1", checkpointTurnCount: 1 },
        { turnId: "turn-2", checkpointTurnCount: 2 },
      ],
    );
    expect(fold.latestId).toBe("b");
    expect(fold.applyRevert(1)).toBe(true);
    expect(fold.latestId).toBe("a");
    expect(fold.applyRevert(0)).toBe(true);
    expect(fold.latestId).toBeNull();
    expect(fold.latestItemType).toBeNull();
  });
  it("keeps unscoped rows across reverts", () => {
    const fold = new WorkspaceMutationFold();
    fold.applyActivity(activity({ itemType: "file_change", id: "loose", turnId: null }));
    fold.applyCheckpoint("turn-1", 1);
    fold.applyActivity(activity({ itemType: "file_change", id: "scoped", turnId: "turn-1" }));
    expect(fold.applyRevert(0)).toBe(true);
    expect(fold.latestId).toBe("loose");
  });
  it("ignores a revert that retains every qualifying row", () => {
    const fold = new WorkspaceMutationFold();
    fold.applyCheckpoint("turn-1", 1);
    fold.applyActivity(activity({ itemType: "file_change", id: "x", turnId: "turn-1" }));
    expect(fold.applyRevert(3)).toBe(false);
    expect(fold.latestId).toBe("x");
  });
  it("resets on thread recreation", () => {
    const fold = new WorkspaceMutationFold();
    fold.applyActivity(activity({ itemType: "file_change", id: "x" }));
    expect(fold.reset()).toBe(true);
    expect(fold.latestId).toBeNull();
    expect(fold.reset()).toBe(false);
  });
});

describe("retainedTurnIdsAfterRevert", () => {
  it("retains turns at or below the target checkpoint count", () => {
    const retained = retainedTurnIdsAfterRevert(
      [
        { turnId: "t1", checkpointTurnCount: 1 },
        { turnId: "t2", checkpointTurnCount: 2 },
        { turnId: "t3", checkpointTurnCount: null },
        { turnId: null, checkpointTurnCount: 1 },
      ],
      1,
    );
    expect([...retained].sort()).toEqual(["t1"]);
  });
});
