import { act, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type PickerRefresh = { environmentId: string; input: { cwd: string } };

const checkout = vi.hoisted(() => ({
  projectRoot: "",
  focused: false,
  worktreePath: null as string | null,
  branches: [] as Array<{ name: string; worktreePath: string | null }>,
  branchUpdates: new EventTarget(),
}));

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (onFocus: () => void) => {
    const { focused } = checkout;
    useEffect(() => {
      if (focused) onFocus();
    }, [focused, onFocus]);
  },
  useNavigation: () => ({}),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async (
    _registry: unknown,
    refresh: (input: PickerRefresh) => Promise<void>,
    input: PickerRefresh,
  ) => refresh(input),
}));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/FitSheet", () => ({
  FitSheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/FormSection", () => ({
  FormSection: () => null,
  FormField: () => null,
}));
vi.mock("../../../components/ui/ListSection", () => ({
  ListSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: { label: string; description: string; disabled: boolean }) => (
    <button disabled={props.disabled}>
      <span>{props.label}</span>
      <span>{props.description}</span>
    </button>
  ),
}));
vi.mock("./gitSheetComponents", () => ({ SheetActionButton: () => null }));
vi.mock("../../../state/entities", () => ({}));
vi.mock("../../../state/threads", () => ({}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1", worktreePath: checkout.worktreePath },
    selectedThreadProject: { workspaceRoot: checkout.projectRoot },
  }),
}));
vi.mock("../../../state/use-thread-detail", () => ({
  useSelectedThreadWorktreePath: () => checkout.worktreePath,
}));
vi.mock("../../../state/use-selected-thread-git-state", () => {
  const subscribe = (listener: () => void) => {
    checkout.branchUpdates.addEventListener("change", listener);
    return () => checkout.branchUpdates.removeEventListener("change", listener);
  };
  return {
    useSelectedThreadGitState: () => ({
      selectedThreadBranches: useSyncExternalStore(subscribe, () => checkout.branches),
      selectedThreadBranchesLoading: false,
      gitOperationLabel: null,
    }),
  };
});
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({ canChangeThreadBranch: true }),
}));
vi.mock("../../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../../state/vcs", () => ({
  vcsEnvironment: {
    branch: () => null,
    refreshLocalStatusForPicker: async ({ environmentId, input }: PickerRefresh) => {
      if (environmentId !== "environment-1" || input.cwd !== checkout.projectRoot) return;
      await Promise.resolve();
      checkout.branches = checkout.branches.map((branch) =>
        branch.name === "feature/linked" ? { ...branch, worktreePath: "/repo-linked" } : branch,
      );
      checkout.branchUpdates.dispatchEvent(new Event("change"));
    },
  },
}));

import { GitBranchesSheet } from "./GitBranchesSheet";

it("refreshes worktree occupancy on focus and recognizes the thread's active checkout", async () => {
  const directory = "/repo";
  const linked = "/repo-linked";
  checkout.projectRoot = directory;
  checkout.focused = false;
  checkout.branches = [
    { name: "feature/available", worktreePath: null },
    { name: "feature/linked", worktreePath: null },
    { name: "main", worktreePath: directory },
  ];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    root.render(
      <GitBranchesSheet
        route={{ params: { environmentId: "environment-1", threadId: "thread-1" } }}
      />,
    );
  const rows = () =>
    [...container.querySelectorAll("button")].map((button) => ({
      name: button.querySelectorAll("span")[0]?.textContent,
      subtitle: button.querySelectorAll("span")[1]?.textContent,
      disabled: button.disabled,
    }));
  try {
    checkout.worktreePath = null;
    act(render);
    expect(rows()[1]).toEqual({
      name: "feature/linked",
      subtitle: "Local branch",
      disabled: false,
    });

    checkout.focused = true;
    await act(render);
    expect(rows()).toEqual([
      { name: "feature/available", subtitle: "Local branch", disabled: false },
      { name: "feature/linked", subtitle: "Checked out in another worktree", disabled: true },
      { name: "main", subtitle: "Checked out in this thread", disabled: false },
    ]);

    checkout.worktreePath = linked;
    act(render);
    expect(rows()).toEqual([
      { name: "feature/available", subtitle: "Local branch", disabled: false },
      { name: "feature/linked", subtitle: "Checked out in this thread", disabled: false },
      { name: "main", subtitle: "Checked out in another worktree", disabled: true },
    ]);
  } finally {
    act(() => root.unmount());
  }
});
