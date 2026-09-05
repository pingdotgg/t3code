import { AuthOrchestrationOperateScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canOperate: false,
  checkouts: [] as string[],
  setupScripts: 0,
  prepared: [] as { branch: string; worktreePath: string | null }[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));
vi.mock("@tanstack/react-pacer", () => ({
  useDebouncedValue: (value: unknown) => [value, { state: { isPending: false } }],
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.canOperate,
  readEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.canOperate,
}));
vi.mock("~/lib/sourceControlActions", () => ({
  readCachedPullRequestResolution: () => null,
  usePullRequestResolution: () => ({
    data: { pullRequest: { number: 123, title: "Pull request", state: "open" } },
  }),
  usePreparePullRequestThreadAction: () => ({
    isAllowed: true,
    isPending: false,
    error: null,
    run: async ({ mode, threadId }: { mode: string; threadId?: string }) => {
      state.checkouts.push(mode);
      if (mode === "worktree" && threadId) state.setupScripts += 1;
      return {
        _tag: "Success",
        value: { branch: "feature/pr", worktreePath: mode === "worktree" ? "/worktree" : null },
      };
    },
  }),
}));
vi.mock("~/lib/utils", () => ({ cn: () => "" }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("./ui/button", () => ({ Button: "Button" }));
vi.mock("./ui/input", () => ({ Input: "Input" }));
vi.mock("./ui/spinner", () => ({ Spinner: "Spinner" }));
vi.mock("./ui/dialog", () => ({
  Dialog: "Dialog",
  DialogDescription: "DialogDescription",
  DialogFooter: "DialogFooter",
  DialogHeader: "DialogHeader",
  DialogPanel: "DialogPanel",
  DialogPopup: "DialogPopup",
  DialogTitle: "DialogTitle",
}));

import { PullRequestThreadDialog } from "./PullRequestThreadDialog";

function findAction(node: ReactNode, label: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const action = findAction(child, label);
      if (action) return action;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => unknown }>(node)) return null;
  if (node.props.children === label) return node.props.onClick ?? null;
  return findAction(node.props.children, label);
}

function prepareAction(label: "Local" | "Worktree") {
  const action = findAction(
    PullRequestThreadDialog({
      open: true,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      cwd: "/repo",
      initialReference: "123",
      onOpenChange: () => {},
      onPrepared: (input) => {
        state.prepared.push(input);
      },
    }),
    label,
  );
  if (!action) throw new Error(`${label} action missing`);
  return action;
}

describe("pull request worktree permissions", () => {
  beforeEach(() => {
    state.canOperate = false;
    state.checkouts = [];
    state.setupScripts = 0;
    state.prepared = [];
  });

  it("does not prepare a worktree or run setup with only source-control permission", async () => {
    await prepareAction("Worktree")();

    expect(state.checkouts).toEqual([]);
    expect(state.setupScripts).toBe(0);
    expect(state.prepared).toEqual([]);
  });

  it("prepares the worktree and thread when task permission is also granted", async () => {
    state.canOperate = true;
    await prepareAction("Worktree")();

    expect(state.checkouts).toEqual(["worktree"]);
    expect(state.setupScripts).toBe(1);
    expect(state.prepared).toEqual([{ branch: "feature/pr", worktreePath: "/worktree" }]);
  });

  it("rechecks task permission before invoking a retained worktree action", async () => {
    state.canOperate = true;
    const prepare = prepareAction("Worktree");
    state.canOperate = false;
    await prepare();

    expect(state.checkouts).toEqual([]);
    expect(state.setupScripts).toBe(0);
  });

  it("keeps local checkout available without task permission", async () => {
    await prepareAction("Local")();

    expect(state.checkouts).toEqual(["local"]);
    expect(state.setupScripts).toBe(0);
    expect(state.prepared).toEqual([{ branch: "feature/pr", worktreePath: null }]);
  });
});
