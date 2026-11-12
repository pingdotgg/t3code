import { describe, expect, it } from "@effect/vitest";

import { orchestrationV2WorktreePending } from "./orchestrationV2ThreadError.ts";

describe("orchestrationV2WorktreePending", () => {
  const run = (status: string, type: string, ordinal = 1) => ({
    status,
    ordinal,
    completedAt: null,
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
    // A worktree failure holds while it is the latest executed run.
    expect(orchestrationV2WorktreePending(null, [run("failed", "worktree") as never])).toBe(true);
    expect(
      orchestrationV2WorktreePending(null, [
        run("failed", "worktree") as never,
        run("completed", "none", 2) as never,
      ]),
    ).toBe(false);
    expect(orchestrationV2WorktreePending("/w", [run("failed", "worktree") as never])).toBe(false);
  });
});
