import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Error: "error" },
  notificationAsync: () => Promise.resolve(),
}));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
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

import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadGitState } from "./use-selected-thread-git-state";
import {
  dismissGitActionResult,
  showGitActionResult,
  useGitActionProgress,
  type GitActionResultNotification,
} from "./use-vcs-action-state";

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

const owner = { environmentId: EnvironmentId.make("first"), threadId: ThreadId.make("thread-a") };
const otherThread = { ...owner, threadId: ThreadId.make("thread-b") };
const otherEnvironment = { ...owner, environmentId: EnvironmentId.make("second") };
const pulled = {
  threadRef: owner,
  type: "success",
  title: "Pulled latest on feature",
} satisfies GitActionResultNotification & { readonly threadRef: ScopedThreadRef };
const rejected = {
  threadRef: otherThread,
  type: "error",
  title: "Git action failed",
  description: "rejected",
} satisfies GitActionResultNotification & { readonly threadRef: ScopedThreadRef };
const dismiss: (threadRef: ScopedThreadRef) => void = dismissGitActionResult;

function mountGitBanner() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);

  function Banner({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
    const progress = useGitActionProgress(
      { environmentId: threadRef?.environmentId ?? null, cwd: "/repo" },
      threadRef,
    );
    return progress.label;
  }

  return {
    select(threadRef: ScopedThreadRef | null) {
      act(() => {
        root.render(
          <RegistryContext.Provider value={appAtomRegistry}>
            <Banner threadRef={threadRef} />
          </RegistryContext.Provider>,
        );
      });
    },
    get text() {
      return container.textContent;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("thread Git result banners", () => {
  it.each([
    { name: "another thread in the same checkout", viewer: otherThread },
    { name: "the same thread ID in another environment", viewer: otherEnvironment },
    { name: "no selected thread", viewer: null },
  ])("hides the owner's result from $name", ({ viewer }) => {
    showGitActionResult(pulled);
    try {
      using banner = mountGitBanner();
      banner.select(owner);
      expect(banner.text).toBe(pulled.title);
      banner.select(viewer);
      expect(banner.text).toBe("");
    } finally {
      dismiss(owner);
    }
  });

  it("keeps both results when the first thread finishes after the second", () => {
    try {
      using banner = mountGitBanner();
      showGitActionResult(rejected);
      banner.select(otherThread);
      act(() => showGitActionResult(pulled));
      expect(banner.text).toBe(rejected.title);
      act(() => dismiss(otherThread));
      expect(banner.text).toBe("");
      banner.select(owner);
      expect(banner.text).toBe(pulled.title);
    } finally {
      dismiss(owner);
      dismiss(otherThread);
    }
  });
});
