import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type PressProps = {
  label?: string;
  accessibilityLabel?: string;
  accessibilityState?: { checked?: boolean };
  onPress: () => void;
};
const state = vi.hoisted(() => ({
  refName: "main",
  result: null as object | null,
  pressables: [] as PressProps[],
  buttons: [] as PressProps[],
  ran: [] as object[],
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => children,
  Pressable: (props: PressProps & { children: ReactNode }) => {
    state.pressables.push(props);
    return null;
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => {} }) }));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/FitSheet", () => ({
  FitSheet: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: () => null,
  AppTextInput: () => null,
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: PressProps) => {
    state.buttons.push(props);
    return null;
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      refName: state.refName,
      isDefaultRef: false,
      workingTree: {
        files: [
          { path: "include.ts", insertions: 1, deletions: 0 },
          { path: "later.ts", insertions: 1, deletions: 0 },
        ],
      },
    },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment" } }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: null }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canWriteSourceControl: true,
    canCreateFeatureBranch: true,
    onRunSelectedThreadGitAction: (input: object) => {
      state.ran.push(input);
      return Promise.resolve(state.result);
    },
  }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));

import { GitCommitSheet } from "./GitCommitSheet";

function openSheet() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const render = () => {
    state.pressables = [];
    state.buttons = [];
    root.render(
      <GitCommitSheet route={{ params: { environmentId: "environment", threadId: "thread" } }} />,
    );
  };
  act(render);
  const row = (path: string) => state.pressables.findLast((p) => p.accessibilityLabel === path)!;
  return {
    isIncluded: (path: string) => row(path).accessibilityState?.checked,
    toggle: (path: string) => act(() => row(path).onPress()),
    // The sheet closes on submit, so it unmounts once the commit settles.
    commit: async () => {
      await act(async () => state.buttons.findLast((b) => b.label === "Commit changes")!.onPress());
      act(() => root.unmount());
    },
  };
}

it("keeps excluded files after a failed commit until a commit succeeds", async () => {
  const first = openSheet();
  first.toggle("later.ts");
  state.result = null;
  await first.commit();

  const retry = openSheet();
  expect(retry.isIncluded("later.ts")).toBe(false);
  expect(retry.isIncluded("include.ts")).toBe(true);
  state.result = { commit: { status: "created" } };
  await retry.commit();
  expect(state.ran).toEqual([
    { action: "commit", featureBranch: false, filePaths: ["include.ts"] },
    { action: "commit", featureBranch: false, filePaths: ["include.ts"] },
  ]);

  expect(openSheet().isIncluded("later.ts")).toBe(true);
});
