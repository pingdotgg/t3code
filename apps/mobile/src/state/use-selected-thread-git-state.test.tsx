import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  root: "",
  cwd: "",
}));

vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1" },
    selectedThreadProject: { workspaceRoot: harness.root },
  }),
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: harness.cwd }),
}));
vi.mock("./use-vcs-action-state", () => ({
  useVcsActionState: () => ({ currentLabel: null }),
}));
vi.mock("./sourceControl", () => ({
  sourceControlEnvironment: { discovery: () => null },
}));
vi.mock("./query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("./queries", () => ({
  useBranches: ({ cwd }: { cwd: string }) => ({
    data: {
      refs: NodeChildProcess.execFileSync(
        "git",
        ["for-each-ref", "--format=%(refname:short) %(HEAD)", "refs/heads"],
        {
          cwd,
          encoding: "utf8",
        },
      )
        .trim()
        .split("\n")
        .map((line) => ({
          name: line.split(" ")[0],
          current: line.endsWith("*"),
          isRemote: false,
        })),
    },
    isPending: false,
  }),
}));

import { useSelectedThreadGitState } from "./use-selected-thread-git-state";

it("marks the selected checkout's branch current when switching threads in one project", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-branches-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
    });
  const root = createRoot(document.createElement("div"));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let currentBranches: string[] = [];
  function Consumer() {
    const { selectedThreadBranches } = useSelectedThreadGitState();
    useLayoutEffect(() => {
      currentBranches = selectedThreadBranches
        .filter((branch) => branch.current)
        .map((branch) => branch.name);
    }, [selectedThreadBranches]);
    return null;
  }

  try {
    git("init", "--initial-branch=main");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    );
    const worktree = NodePath.join(directory, "linked");
    git("worktree", "add", "-b", "feature/mobile", worktree);
    harness.root = directory;
    harness.cwd = directory;
    act(() => root.render(<Consumer />));
    expect(currentBranches).toEqual(["main"]);

    harness.cwd = worktree;
    act(() => root.render(<Consumer />));
    expect(currentBranches).toEqual(["feature/mobile"]);

    harness.cwd = directory;
    act(() => root.render(<Consumer />));
    expect(currentBranches).toEqual(["main"]);
  } finally {
    act(() => root.unmount());
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
