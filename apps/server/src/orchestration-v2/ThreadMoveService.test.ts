import { describe, expect, it } from "@effect/vitest";
import type { ThreadMoveGit, ThreadMoveMessage } from "@t3tools/contracts";

import { planMoveWorkspace, selectMoveHistory } from "./ThreadMoveService.ts";

const message = (role: "user" | "assistant", text: string): ThreadMoveMessage => ({
  role,
  text,
  createdAt: "2026-11-23T00:00:00.000Z",
});

describe("selectMoveHistory", () => {
  it("keeps everything that fits", () => {
    const messages = [message("user", "a"), message("assistant", "b")];
    expect(selectMoveHistory(messages, 10)).toEqual({ messages, omittedMessageCount: 0 });
  });

  it("keeps the first request and the newest history, in order", () => {
    const messages = [
      message("assistant", "intro"),
      message("user", "first"),
      message("assistant", "old answer"),
      message("user", "middle"),
      message("assistant", "new"),
    ];
    // "first" (5) + "new" (3) + "middle" (6) = 14; "old answer" no longer fits.
    expect(selectMoveHistory(messages, 14)).toEqual({
      messages: [message("user", "first"), message("user", "middle"), message("assistant", "new")],
      omittedMessageCount: 2,
    });
  });

  it("stops at the first newer message that does not fit, leaving no gaps", () => {
    const messages = [
      message("user", "q"),
      message("assistant", "short"),
      message("assistant", "this one is far too long"),
      message("user", "end"),
    ];
    expect(selectMoveHistory(messages, 4).messages).toEqual([
      message("user", "q"),
      message("user", "end"),
    ]);
  });

  it("counts bytes, not characters", () => {
    const messages = [message("user", "é".repeat(3))];
    expect(selectMoveHistory(messages, 5).omittedMessageCount).toBe(1);
  });
});

describe("planMoveWorkspace", () => {
  const pushed: ThreadMoveGit = {
    branch: "feature/move",
    remoteBranch: "feature/move",
    headCommit: "abc",
    unpushedCommitCount: 0,
    uncommittedFileCount: 0,
  };
  const workspaceRoot = "/home/user/app";

  it("uses the target's default workspace without a pushed branch", () => {
    expect(
      planMoveWorkspace({ git: null, workspaceRoot, targetBranch: { type: "absent" } }),
    ).toEqual({
      type: "default",
      reason: "no-git",
    });
    expect(
      planMoveWorkspace({
        git: { ...pushed, remoteBranch: null },
        workspaceRoot,
        targetBranch: { type: "absent" },
      }),
    ).toEqual({ type: "default", reason: "not-pushed" });
  });

  it("starts a new worktree from the remote branch the source tracks", () => {
    expect(
      planMoveWorkspace({
        git: { ...pushed, remoteBranch: "main" },
        workspaceRoot,
        targetBranch: { type: "absent" },
      }),
    ).toMatchObject({
      type: "carry",
      strategy: {
        type: "worktree",
        baseRef: "main",
        branch: "feature/move",
        startFromOrigin: true,
      },
      reusedCheckout: false,
    });
  });

  it("reuses a checkout the target already has of the branch", () => {
    expect(
      planMoveWorkspace({
        git: pushed,
        workspaceRoot,
        targetBranch: { type: "checked-out", worktreePath: "/home/user/worktrees/move" },
      }),
    ).toMatchObject({
      strategy: { type: "existing_worktree", worktreePath: "/home/user/worktrees/move" },
      reusedCheckout: true,
      addWorktree: false,
    });
    expect(
      planMoveWorkspace({
        git: pushed,
        workspaceRoot,
        targetBranch: { type: "checked-out", worktreePath: `${workspaceRoot}/` },
      }),
    ).toMatchObject({ strategy: { type: "root", branch: "feature/move" }, reusedCheckout: true });
  });

  it("adds a worktree for a local branch nothing has checked out", () => {
    expect(
      planMoveWorkspace({ git: pushed, workspaceRoot, targetBranch: { type: "unchecked" } }),
    ).toMatchObject({ type: "carry", addWorktree: true, reusedCheckout: true });
  });
});
