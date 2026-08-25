import { describe, expect, it } from "vite-plus/test";

import { type VcsRef } from "@t3tools/client-runtime/state/vcs";
import { resolveStartWorkspace } from "./new-task-workspace-resolution";

function makeBranch(name: string, overrides: Partial<VcsRef> = {}): VcsRef {
  return {
    name,
    current: false,
    isDefault: false,
    worktreePath: null,
    ...overrides,
  };
}

function branches(refs: ReadonlyArray<VcsRef>): {
  readonly all: ReadonlyArray<VcsRef>;
  readonly available: ReadonlyArray<VcsRef>;
} {
  return { all: refs, available: refs.filter((ref) => !ref.isRemote) };
}

describe("resolveStartWorkspace", () => {
  it("leaves a local thread untouched", () => {
    const input = { mode: "local" as const, branch: null, worktreePath: "/work/checkout" };
    expect(resolveStartWorkspace(input, branches([makeBranch("main", { isDefault: true })]))).toBe(
      input,
    );
  });

  it("leaves a worktree thread with a chosen branch untouched", () => {
    const input = { mode: "worktree" as const, branch: "feature", worktreePath: null };
    expect(resolveStartWorkspace(input, branches([makeBranch("main", { isDefault: true })]))).toBe(
      input,
    );
  });

  it("picks the default branch for a worktree with no branch", () => {
    const resolved = resolveStartWorkspace(
      { mode: "worktree", branch: null, worktreePath: null },
      branches([makeBranch("dev", { current: true }), makeBranch("main", { isDefault: true })]),
    );
    expect(resolved).toEqual({ mode: "worktree", branch: "main", worktreePath: null });
  });

  it("finds a default that only exists as a remote-only ref", () => {
    // origin/main is filtered out of `available`, so it must be found via `all`.
    const resolved = resolveStartWorkspace(
      { mode: "worktree", branch: null, worktreePath: null },
      branches([
        makeBranch("origin/main", { isDefault: true, isRemote: true, remoteName: "origin" }),
        makeBranch("dev"),
      ]),
    );
    expect(resolved.branch).toBe("origin/main");
    expect(resolved.mode).toBe("worktree");
  });

  it("falls back to the current branch when no ref is flagged default", () => {
    const resolved = resolveStartWorkspace(
      { mode: "worktree", branch: null, worktreePath: null },
      branches([makeBranch("dev"), makeBranch("checkout", { current: true })]),
    );
    expect(resolved.branch).toBe("checkout");
  });

  it("falls back to the first local branch when none is default or current", () => {
    const resolved = resolveStartWorkspace(
      { mode: "worktree", branch: null, worktreePath: null },
      branches([
        makeBranch("origin/main", { isRemote: true, remoteName: "origin" }),
        makeBranch("first"),
        makeBranch("second"),
      ]),
    );
    expect(resolved.branch).toBe("first");
  });

  it("falls back to a current-checkout thread when no branch is known", () => {
    const resolved = resolveStartWorkspace(
      { mode: "worktree", branch: null, worktreePath: "/work/checkout" },
      branches([]),
    );
    // Local checkout needs no branch, so the task can always start; the
    // caller's worktreePath is preserved for the local thread.
    expect(resolved).toEqual({ mode: "local", branch: null, worktreePath: "/work/checkout" });
  });

  it("falls back to local when only remote-only refs exist", () => {
    const resolved = resolveStartWorkspace(
      { mode: "worktree", branch: null, worktreePath: null },
      // A remote-only ref with no default flag cannot base a worktree directly.
      branches([makeBranch("origin/feature", { isRemote: true, remoteName: "origin" })]),
    );
    expect(resolved.mode).toBe("local");
  });
});
