import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupThreadsByColumn, type BoardThread } from "./taskBoard.logic";

const NOW = "2026-01-01T12:00:00.000Z";

function thread(id: string, overrides: Partial<BoardThread> = {}): BoardThread & { id: string } {
  return {
    id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    updatedAt: "2026-01-01T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    snoozedUntil: null,
    ...overrides,
  } as BoardThread & { id: string };
}

const ids = (threads: ReadonlyArray<{ id: string }>) => threads.map((t) => t.id);

describe("groupThreadsByColumn", () => {
  it("places threads by status, settled and snoozed taking precedence, and drops hidden ones", () => {
    const groups = groupThreadsByColumn(
      [
        thread("approval", { hasPendingApprovals: true }),
        thread("done"),
        thread("settled", { settledOverride: "settled", hasPendingApprovals: true }),
        thread("snoozed", { snoozedUntil: "2026-01-02T00:00:00.000Z" }),
        thread("archived", { archivedAt: "2026-01-01T00:00:00.000Z" }),
        thread("sub", {
          lineage: {
            parentThreadId: ThreadId.make("done"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("done"),
          },
        }),
      ],
      NOW,
    );
    expect(ids(groups.attention)).toEqual(["approval"]);
    expect(ids(groups.done)).toEqual(["done"]);
    expect(ids(groups.settled)).toEqual(["settled"]);
    expect(ids(groups.snoozed)).toEqual(["snoozed"]);
    expect(ids(groups.working)).toEqual([]);
  });

  it("orders pinned first, then newest update", () => {
    const groups = groupThreadsByColumn(
      [
        thread("old", { updatedAt: "2026-01-01T01:00:00.000Z" }),
        thread("new", { updatedAt: "2026-01-01T09:00:00.000Z" }),
        thread("pinned", { pinnedAt: NOW, updatedAt: "2025-12-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(ids(groups.done)).toEqual(["pinned", "new", "old"]);
  });
});
