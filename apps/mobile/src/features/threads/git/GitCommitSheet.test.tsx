import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  paths: ["a.txt", "b.txt"],
  cwd: "/repo",
  commit: vi.fn(),
  renderFooter: (_footer: ReactNode) => {},
}));

// Navigation materializes native footers only when screen options change.
vi.mock("@react-navigation/native", async () => {
  const { createContext } = await vi.importActual<typeof import("react")>("react");
  const navigation = {
    goBack() {},
    setOptions(options: { unstable_sheetFooter?: () => ReactNode }) {
      state.renderFooter(options.unstable_sheetFooter?.());
    },
  };
  return {
    useNavigation: () => navigation,
    NavigationContext: createContext(navigation),
    NavigationRouteContext: createContext(undefined),
  };
});
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => children,
  ScrollView: ({ children }: { children: ReactNode }) => children,
  Pressable: (props: { accessibilityLabel: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => children,
  AppTextInput: () => null,
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      workingTree: { files: state.paths.map((path) => ({ path, insertions: 1, deletions: 0 })) },
    },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment" } }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: state.cwd }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: null }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => {
    const cwd = state.cwd;
    return {
      canWriteSourceControl: true,
      canChangeThreadBranch: true,
      onRunSelectedThreadGitAction: (input: unknown) => state.commit(cwd, input),
    };
  },
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));

import { GitCommitSheet } from "./GitCommitSheet";

it("commits all files in the current worktree after Select all and a worktree switch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const body = document.createElement("div");
  const footer = document.createElement("div");
  const root = createRoot(body);
  const footerRoot = createRoot(footer);
  state.renderFooter = (children) => footerRoot.render(children);
  state.paths = ["a.txt", "b.txt"];
  state.cwd = "/repo";
  state.commit.mockClear();
  const render = () =>
    act(() =>
      root.render(
        <GitCommitSheet route={{ params: { environmentId: "environment", threadId: "thread" } }} />,
      ),
    );
  try {
    render();
    act(() => body.querySelector<HTMLButtonElement>('[aria-label="b.txt"]')!.click());
    state.paths = ["a.txt"];
    render();
    act(() =>
      Array.from(body.querySelectorAll("button"))
        .find((button) => button.textContent === "Select all")!
        .click(),
    );
    state.cwd = "/other";
    render();
    await act(async () => {
      Array.from([...footer.querySelectorAll("button"), ...body.querySelectorAll("button")])
        .find((button) => button.textContent === "Commit changes")!
        .click();
    });
    expect(state.commit).toHaveBeenCalledExactlyOnceWith("/other", {
      action: "commit",
      featureBranch: false,
    });
  } finally {
    act(() => root.unmount());
    act(() => footerRoot.unmount());
    vi.unstubAllGlobals();
  }
});
