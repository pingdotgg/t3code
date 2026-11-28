import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type ActionProps = { label: string; disabled?: boolean; onPress: () => void };
type IntroProps = { title: string; description: string };
const state = vi.hoisted(() => ({
  refName: null as string | null,
  intro: null as IntroProps | null,
  actions: [] as ActionProps[],
  ran: [] as object[],
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {} }),
}));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/FitSheet", () => ({
  FitSheet: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/SheetIntro", () => ({
  SheetIntro: (props: IntroProps) => {
    state.intro = props;
    return null;
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.refName === null ? undefined : { refName: state.refName },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment" },
    selectedThreadProject: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ selectedThreadBranches: [] }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canWriteSourceControl: true,
    canCreateFeatureBranch: true,
    onRunSelectedThreadGitAction: (input: object) => {
      state.ran.push(input);
      return Promise.resolve(null);
    },
  }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../thread-inspector-navigation", () => ({ useReturnToThread: () => () => {} }));
vi.mock("./gitSheetComponents", () => ({
  SheetActionButton: (props: ActionProps) => {
    state.actions.push(props);
    return null;
  },
}));

import { GitConfirmSheet } from "./GitConfirmSheet";

function setup(refName: string | null, params: Record<string, string>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.refName = refName;
  state.intro = null;
  state.actions = [];
  state.ran = [];
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(
      <GitConfirmSheet
        route={{ params: { environmentId: "environment", threadId: "thread", ...params } }}
      />,
    );
  });
  // Each render registers Continue first, then the feature branch button.
  const [continueButton, featureBranchButton] = state.actions.slice(-2);
  return {
    continueButton: continueButton!,
    featureBranchButton: featureBranchButton!,
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("describes the action it runs on the branch that is checked out", async () => {
  using screen = setup("main", {
    confirmAction: "commit_push",
    branchName: "docs",
    includesCommit: "false",
    commitMessage: "from the route",
    filePaths: "a.ts,b.ts",
  });
  expect(state.intro).toMatchObject({
    title: "Commit & push to default branch?",
    description: expect.stringContaining('commit and push changes on "main"'),
  });
  expect(screen.continueButton.label).toBe("Commit & push to main");
  await act(async () => screen.continueButton.onPress());
  await act(async () => screen.featureBranchButton.onPress());
  expect(state.ran).toEqual([
    { action: "commit_push" },
    { action: "commit_push", featureBranch: true },
  ]);
});

it.each([
  ["an action it does not confirm", "main", "commit"],
  ["no checked out branch", null, "push"],
])("runs nothing for %s", async (_case, refName, confirmAction) => {
  using screen = setup(refName, { confirmAction });
  expect(screen.continueButton.disabled).toBe(true);
  expect(screen.featureBranchButton.disabled).toBe(true);
  await act(async () => screen.continueButton.onPress());
  await act(async () => screen.featureBranchButton.onPress());
  expect(state.ran).toEqual([]);
});
