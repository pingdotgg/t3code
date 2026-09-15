import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  fields: [] as string[],
  fieldIndex: 0,
  canChangeThreadBranch: true,
  navigations: 0,
  result: Promise.resolve(null) as Promise<unknown>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: string) => {
    const index = state.fieldIndex++;
    state.fields[index] ??= initial;
    return [state.fields[index], (value: string) => (state.fields[index] = value)];
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => state.navigations++ }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../../components/AndroidScreenHeader", () => ({
  AndroidSheetHeader: "AndroidSheetHeader",
}));
vi.mock("../../../components/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("./gitSheetComponents", () => ({ SheetActionButton: "SheetActionButton" }));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { refName: "main" } }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment", branch: "main" } }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/repo",
    selectedThreadWorktreePath: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({
    selectedThreadBranches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    selectedThreadBranchesLoading: false,
    gitOperationLabel: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canChangeThreadBranch: state.canChangeThreadBranch,
    onCreateSelectedThreadBranch: () => state.result,
    onCreateSelectedThreadWorktree: () => state.result,
    onCheckoutSelectedThreadBranch: () => state.result,
  }),
}));

import { GitBranchesSheet } from "./GitBranchesSheet";

type ControlProps = {
  label?: string;
  placeholder?: string;
  onPress?: () => unknown;
  onChangeText?: (value: string) => void;
  value?: string;
  children?: ReactNode;
};

function findControl(node: ReactNode, label: string): ControlProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const control = findControl(child, label);
      if (control) return control;
    }
    return null;
  }
  if (!isValidElement<ControlProps>(node)) return null;
  if (
    node.props.label === label ||
    node.props.placeholder === label ||
    (label === "checkout" && node.type === "Pressable")
  ) {
    return node.props;
  }
  return findControl(node.props.children, label);
}

function control(label: string) {
  state.fieldIndex = 0;
  const found = findControl(
    GitBranchesSheet({ route: { params: { environmentId: "environment", threadId: "thread" } } }),
    label,
  );
  if (!found) throw new Error(`Missing sheet control: ${label}`);
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("branch sheet operation completion", () => {
  beforeEach(() => {
    state.fields = [];
    state.fieldIndex = 0;
    state.canChangeThreadBranch = true;
    state.navigations = 0;
    control("feature/mobile-polish").onChangeText?.("feature/branch");
    control("main").onChangeText?.("release");
    control("feature/mobile-thread").onChangeText?.("feature/worktree");
  });

  it.each(["Create & checkout", "Create worktree", "checkout"])(
    "keeps the sheet and its input when %s cannot complete",
    async (operation) => {
      const result = deferred<null>();
      state.result = result.promise;
      const press = control(operation).onPress;
      if (!press) throw new Error("Missing operation handler");
      state.canChangeThreadBranch = false;
      const completion = press();
      result.resolve(null);
      await result.promise;
      await completion;

      expect(state.navigations).toBe(0);
      expect(control("feature/mobile-polish").value).toBe("feature/branch");
      expect(control("main").value).toBe("release");
      expect(control("feature/mobile-thread").value).toBe("feature/worktree");
    },
  );

  it.each(["Create & checkout", "Create worktree", "checkout"])(
    "dismisses after accepted %s completion even if the source grant changes",
    async (operation) => {
      const result = deferred<unknown>();
      state.result = result.promise;
      const press = control(operation).onPress;
      if (!press) throw new Error("Missing operation handler");
      const completion = press();
      state.canChangeThreadBranch = false;
      result.resolve(
        operation === "Create worktree"
          ? { worktree: { path: "/repo-worktree", refName: "feature/worktree" } }
          : { refName: operation === "checkout" ? "main" : "feature/branch" },
      );
      await result.promise;
      await completion;

      expect(state.navigations).toBe(1);
      expect(control("feature/mobile-polish").value).toBe(
        operation === "Create & checkout" ? "" : "feature/branch",
      );
      expect(control("feature/mobile-thread").value).toBe(
        operation === "Create worktree" ? "" : "feature/worktree",
      );
    },
  );
});
