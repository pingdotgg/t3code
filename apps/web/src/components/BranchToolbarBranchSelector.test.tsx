// @vitest-environment jsdom

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  RunId,
  type VcsRef,
} from "@t3tools/contracts";
import { act, createRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  worktreePath: null as string | null,
  started: true,
  refs: null as VcsRef[] | null,
  latestWorktreePath: undefined as string | null | undefined,
  latestStarted: undefined as boolean | undefined,
  updateMetadata: vi.fn().mockResolvedValue({ _tag: "Success" }),
  stopSession: vi.fn().mockResolvedValue({ _tag: "Success" }),
}));
const mainRef: VcsRef = {
  name: "main",
  isDefault: true,
  isRemote: false,
  current: false,
  worktreePath: "/repo",
};
const topicBaseRef: VcsRef = {
  ...mainRef,
  name: "topic-base",
  isDefault: false,
  worktreePath: null,
};
const serverThread = (started = state.started, worktreePath = state.worktreePath) => ({
  id: ThreadId.make("thread"),
  environmentId: EnvironmentId.make("local"),
  projectId: ProjectId.make("project"),
  branch: started ? "topic" : null,
  worktreePath,
  pullRequests: [],
  runtime: started
    ? {
        status: "running",
        activeRunId: RunId.make("run"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
        lastError: null,
        updatedAt: "2026-10-16T00:00:00Z",
      }
    : null,
});
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => serverThread(),
  readThreadShell: () =>
    serverThread(
      state.latestStarted ?? state.started,
      state.latestWorktreePath === undefined ? state.worktreePath : state.latestWorktreePath,
    ),
  useProject: () => ({ id: ProjectId.make("project"), workspaceRoot: "/repo" }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      getDraftThreadByRef: () => ({
        environmentId: "local",
        projectId: "project",
        branch: "topic",
        worktreePath: "/repo/worktree",
        envMode: "worktree",
      }),
      setDraftThreadContext: vi.fn(),
    }),
}));
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { updateMetadata: "update", stopSession: "stop" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "stop" ? state.stopSession : state.updateMetadata,
}));
vi.mock("../state/vcs", () => ({ vcsEnvironment: { status: vi.fn(), listRefs: vi.fn() } }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { refName: "topic", refs: [mainRef] }, refresh: vi.fn() }),
}));
vi.mock("../state/queries", () => ({
  usePaginatedBranches: () => ({
    refs: state.refs ?? [mainRef, topicBaseRef],
    data: { nextCursor: null, totalCount: 2 },
    refresh: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("../hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("./chat/composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./chat/ThreadDetailsPrRows", () => ({ ThreadDetailsPrRows: () => null }));
vi.mock("../rightPanelStore", () => ({ useRightPanelStore: { getState: vi.fn() } }));
vi.mock("./ThreadStatusIndicators", () => ({
  ThreadPullRequestBadgeControl: () => null,
  prStatusIndicator: () => null,
  resolveThreadPullRequestBadge: () => null,
  useLinkedThreadPullRequest: () => null,
}));
// jsdom has no layout measurements for the virtualized list.
vi.mock("@legendapp/list/react", async (importOriginal) => {
  const { LegendList } = await importOriginal<typeof import("@legendapp/list/react")>();
  return {
    LegendList: (props: ComponentProps<typeof LegendList<string>>) => (
      <LegendList {...props} estimatedListSize={{ width: 300, height: 224 }} />
    ),
  };
});

import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";

it.each(["toolbar", "panel"] as const)(
  "refreshes branch rows in %s when the thread or a ref changes worktrees",
  async (displayMode) => {
    vi.clearAllMocks();
    state.worktreePath = "/repo/worktree";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 224),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<BranchToolbarBranchSelectorHandle>();
    const renderSelector = () =>
      root.render(
        <BranchToolbarBranchSelector
          displayMode={displayMode}
          ref={ref}
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          envLocked
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
        />,
      );
    try {
      await act(async () => renderSelector());
      await act(async () => ref.current?.open());
      expect(document.querySelector('[role="option"]')?.getAttribute("aria-disabled")).toBe("true");
      expect(document.body.textContent).toContain("Stop the current turn to switch worktrees.");
      state.worktreePath = null;
      await act(async () => renderSelector());
      const main = document.querySelector<HTMLElement>('[role="option"]');
      expect(main?.textContent).toContain("main");
      expect(main?.getAttribute("aria-disabled")).not.toBe("true");
      expect(document.body.textContent).not.toContain("Stop the current turn to switch worktrees.");
      state.refs = [{ ...mainRef, worktreePath: "/repo/another-worktree" }, topicBaseRef];
      await act(async () => renderSelector());
      expect(main?.getAttribute("aria-disabled")).toBe("true");
      state.refs = null;
      await act(async () => renderSelector());
      expect(main?.getAttribute("aria-disabled")).not.toBe("true");
      await act(async () => main?.click());
      expect(state.updateMetadata).toHaveBeenCalledWith({
        environmentId: "local",
        input: { threadId: "thread", branch: "main", worktreePath: null },
      });
      expect(state.stopSession).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.worktreePath = null;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      state.refs = null;
    }
  },
);

it.each([
  ["toolbar", "base-row pick"],
  ["panel", "base-row pick"],
  ["toolbar", "non-default base-row pick"],
  ["panel", "non-default base-row pick"],
  ["toolbar", "automatic default"],
  ["panel", "automatic default"],
] as const)("keeps a newer run in its worktree during a %s %s", async (displayMode, action) => {
  vi.clearAllMocks();
  state.started = false;
  state.worktreePath = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 224),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<BranchToolbarBranchSelectorHandle>();
  try {
    if (action === "automatic default") {
      state.latestStarted = true;
      state.latestWorktreePath = "/repo/worktree";
    }
    await act(async () =>
      root.render(
        <BranchToolbarBranchSelector
          displayMode={displayMode}
          ref={ref}
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          envLocked={false}
          effectiveEnvModeOverride="worktree"
          activeThreadBranchOverride={action !== "automatic default" ? "topic" : null}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
        />,
      ),
    );
    if (action !== "automatic default") {
      await act(async () => ref.current?.open());
      const refName = action === "base-row pick" ? "main" : "topic-base";
      const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
        option.textContent?.includes(refName),
      );
      expect(row?.textContent).toContain(refName);
      expect(row?.getAttribute("aria-disabled")).not.toBe("true");
      state.latestStarted = true;
      state.latestWorktreePath = "/repo/worktree";
      await act(async () => row?.click());
    }
    expect(state.stopSession).not.toHaveBeenCalled();
    expect(state.updateMetadata).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.started = true;
    state.latestStarted = undefined;
    state.latestWorktreePath = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.refs = null;
  }
});
