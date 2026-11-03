import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const checkout = vi.hoisted(() => ({
  projectRoot: "",
  worktreePath: null as string | null,
  branches: [] as Array<{ name: string; worktreePath: string | null }>,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, disabled }: { children: ReactNode; disabled: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
  useWindowDimensions: () => ({ height: 800 }),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../../components/ui/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: () => null,
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
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({
    selectedThreadBranches: checkout.branches,
    selectedThreadBranchesLoading: false,
    gitOperationLabel: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({ canChangeThreadBranch: true }),
}));
vi.mock("../../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));

import { GitBranchesSheet } from "./GitBranchesSheet";

it("recognizes both the main checkout and a linked worktree as this thread's checkout", () => {
  const directory = "/repo";
  const linked = "/repo-linked";
  checkout.projectRoot = directory;
  checkout.branches = [
    { name: "feature/available", worktreePath: null },
    { name: "feature/linked", worktreePath: linked },
    { name: "main", worktreePath: directory },
  ];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const rows = () => {
    act(() => {
      root.render(
        <GitBranchesSheet
          route={{ params: { environmentId: "environment-1", threadId: "thread-1" } }}
        />,
      );
    });
    return [...container.querySelectorAll("button")].map((button) => ({
      name: button.querySelectorAll("span")[0]?.textContent,
      subtitle: button.querySelectorAll("span")[1]?.textContent,
      disabled: button.disabled,
    }));
  };
  try {
    checkout.worktreePath = null;
    expect(rows()).toEqual([
      { name: "feature/available", subtitle: "Local branch", disabled: false },
      { name: "feature/linked", subtitle: "Checked out in another worktree", disabled: true },
      { name: "main", subtitle: "Checked out in this thread", disabled: false },
    ]);

    checkout.worktreePath = linked;
    expect(rows()).toEqual([
      { name: "feature/available", subtitle: "Local branch", disabled: false },
      { name: "feature/linked", subtitle: "Checked out in this thread", disabled: false },
      { name: "main", subtitle: "Checked out in another worktree", disabled: true },
    ]);
  } finally {
    act(() => root.unmount());
  }
});
