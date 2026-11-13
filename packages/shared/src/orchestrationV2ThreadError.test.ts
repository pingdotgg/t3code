import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { orchestrationV2WorktreePending } from "./orchestrationV2ThreadError.ts";

describe("orchestrationV2WorktreePending", () => {
  const run = (status: string, type: string, ordinal = 1, completedAt: string | null = null) => ({
    status,
    ordinal,
    completedAt: completedAt === null ? null : DateTime.makeUnsafe(completedAt),
    ...(type === "none" ? {} : { workspacePreparation: { type } }),
  });

  it("holds a latest failed sandbox run but releases once a newer run supersedes it", () => {
    expect(orchestrationV2WorktreePending("/w", [run("failed", "sandbox") as never])).toBe(true);
    expect(
      orchestrationV2WorktreePending("/w", [
        run("failed", "sandbox") as never,
        run("completed", "none", 2) as never,
      ]),
    ).toBe(false);
    // A worktree failure holds only while it is the latest executed run.
    expect(orchestrationV2WorktreePending(null, [run("failed", "worktree") as never])).toBe(true);
    expect(
      orchestrationV2WorktreePending(null, [
        run("failed", "worktree") as never,
        run("completed", "none", 2) as never,
      ]),
    ).toBe(false);
    expect(orchestrationV2WorktreePending("/w", [run("failed", "worktree") as never])).toBe(false);
  });

  it("orders a held queue by completion time, not by input order", () => {
    // A queued run never counts, and an older ordinal that finished later wins.
    expect(
      orchestrationV2WorktreePending(null, [
        run("failed", "worktree", 5, "2026-01-01T00:00:00Z") as never,
        run("completed", "none", 1, "2026-01-02T00:00:00Z") as never,
      ]),
    ).toBe(false);
    expect(
      orchestrationV2WorktreePending(null, [
        run("failed", "worktree", 1, "2026-01-03T00:00:00Z") as never,
        run("completed", "none", 9, "2026-01-02T00:00:00Z") as never,
      ]),
    ).toBe(true);
    expect(
      orchestrationV2WorktreePending(null, [
        run("failed", "worktree", 5) as never,
        run("queued", "none", 6) as never,
      ]),
    ).toBe(true);
    expect(
      orchestrationV2WorktreePending(null, [
        run("failed", "worktree", 5) as never,
        run("cancelled", "none", 6) as never,
      ]),
    ).toBe(false);
  });
});
