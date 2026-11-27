import type {
  GitActionRequestInput,
  RunVcsStackedActionInput,
} from "@t3tools/client-runtime/state/vcs";
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
  refName: "main" as string | null,
  cwd: "/repo",
  result: null as object | null,
  pressables: [] as PressProps[],
  buttons: [] as PressProps[],
  ran: [] as object[],
  createdBranch: undefined as string | undefined,
  waitBeforeProgress: null as Promise<void> | null,
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
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: state.cwd }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: null }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canWriteSourceControl: true,
    canCreateFeatureBranch: true,
    onRunSelectedThreadGitAction: async ({
      onProgress,
      ...input
    }: GitActionRequestInput & Pick<RunVcsStackedActionInput, "onProgress">) => {
      state.ran.push(input);
      if (state.waitBeforeProgress) await state.waitBeforeProgress;
      if (state.createdBranch) {
        onProgress?.({
          actionId: "commit",
          cwd: state.cwd,
          action: "commit",
          kind: "action_failed",
          phase: "commit",
          message: "Commit rejected",
          createdBranch: state.createdBranch,
        });
      }
      return state.result;
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
    refresh: () => act(render),
    // The sheet closes on submit, so it unmounts once the commit settles.
    commit: async (label = "Commit changes") => {
      await act(async () => state.buttons.findLast((b) => b.label === label)!.onPress());
      act(() => root.unmount());
    },
    close: () => act(() => root.unmount()),
  };
}

it("keeps excluded files after a failed commit until a commit succeeds", async () => {
  state.refName = "main";
  state.result = null;
  state.ran = [];

  const first = openSheet();
  first.toggle("later.ts");
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

  const afterSuccess = openSheet();
  expect(afterSuccess.isIncluded("later.ts")).toBe(true);
  afterSuccess.close();
});

it("resets excluded files when moving from detached HEAD to a named branch", async () => {
  state.refName = null;
  state.result = null;
  state.ran = [];

  const detached = openSheet();
  detached.toggle("later.ts");
  await detached.commit();

  const retryDetached = openSheet();
  expect(retryDetached.isIncluded("later.ts")).toBe(false);
  expect(retryDetached.isIncluded("include.ts")).toBe(true);
  retryDetached.close();

  state.refName = "feature";
  const onBranch = openSheet();
  expect(onBranch.isIncluded("include.ts")).toBe(true);
  expect(onBranch.isIncluded("later.ts")).toBe(true);

  state.result = { commit: { status: "created" } };
  await onBranch.commit();
  expect(state.ran).toEqual([
    { action: "commit", featureBranch: false, filePaths: ["include.ts"] },
    { action: "commit", featureBranch: false },
  ]);
});

it.each(["before reopening", "after reopening"])(
  "keeps retry exclusions when new branch status arrives %s",
  async (arrival) => {
    state.cwd = `/repo/${arrival}`;
    state.refName = "main";
    state.result = null;
    state.ran = [];
    state.createdBranch = "feature/retry";

    const first = openSheet();
    first.toggle("later.ts");
    await first.commit("Commit on a new branch");
    state.createdBranch = undefined;

    if (arrival === "before reopening") state.refName = "feature/retry";
    const retry = openSheet();
    expect(retry.isIncluded("later.ts")).toBe(false);
    state.refName = "feature/retry";
    retry.refresh();
    expect(retry.isIncluded("later.ts")).toBe(false);
    state.result = { commit: { status: "created" } };
    await retry.commit();
    expect(state.ran).toEqual([
      { action: "commit", featureBranch: true, filePaths: ["include.ts"] },
      { action: "commit", featureBranch: false, filePaths: ["include.ts"] },
    ]);
  },
);

it.each([
  { checkedOut: "feature/retry", includedAfterFailure: false },
  { checkedOut: "feature/other", includedAfterFailure: true },
])("reconciles an open retry sheet when the action settles on $checkedOut", async (scenario) => {
  state.cwd = `/repo/pending/${scenario.checkedOut}`;
  state.refName = "main";
  state.result = null;
  state.ran = [];
  state.createdBranch = "feature/retry";
  const failure = Promise.withResolvers<void>();
  state.waitBeforeProgress = failure.promise;

  const first = openSheet();
  first.toggle("later.ts");
  await first.commit("Commit on a new branch");

  const retry = openSheet();
  state.refName = scenario.checkedOut;
  retry.refresh();
  const includedWhileRunning = retry.isIncluded("later.ts");
  await act(async () => failure.resolve());
  state.waitBeforeProgress = null;
  state.createdBranch = undefined;

  expect(includedWhileRunning).toBe(false);
  expect(retry.isIncluded("later.ts")).toBe(scenario.includedAfterFailure);
  state.result = { commit: { status: "created" } };
  await retry.commit();
  expect(state.ran.at(-1)).toEqual({
    action: "commit",
    featureBranch: false,
    ...(scenario.includedAfterFailure ? {} : { filePaths: ["include.ts"] }),
  });
});

it("clears inherited exclusions on success with stale branch status", async () => {
  state.cwd = "/repo/pending/success";
  state.refName = "main";
  state.result = { commit: { status: "created" } };
  state.createdBranch = undefined;
  const success = Promise.withResolvers<void>();
  state.waitBeforeProgress = success.promise;

  const first = openSheet();
  first.toggle("later.ts");
  await first.commit("Commit on a new branch");

  const reopened = openSheet();
  expect(reopened.isIncluded("later.ts")).toBe(false);
  await act(async () => success.resolve());
  state.waitBeforeProgress = null;

  expect(reopened.isIncluded("later.ts")).toBe(true);
  reopened.close();
});
