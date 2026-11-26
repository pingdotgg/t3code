import type { VcsListRefsInput, VcsListRefsResult, VcsRef } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { GitBranchesSheet } from "./GitBranchesSheet";

type PressProps = { label: string; disabled?: boolean; onPress: () => void };
const harness = vi.hoisted(() => ({
  cwd: "",
  rows: new Map<string, PressProps>(),
  buttons: new Map<string, PressProps>(),
  checkouts: [] as string[],
  pages: new Map<string, unknown>(),
  footer: undefined as string | undefined,
  // Requests this returns true for stay unanswered until the test sets their atom.
  holds: (_input: VcsListRefsInput): boolean => false,
}));

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({ goBack: () => {}, isFocused: () => true }),
}));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/FitSheet", () => ({
  FitSheet: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/FormSection", () => ({
  FormSection: () => null,
  FormField: () => null,
}));
vi.mock("../../../components/ui/ListSection", () => ({
  ListSection: (props: { children: ReactNode; footer?: string }) => {
    harness.footer = props.footer;
    return props.children;
  },
}));
vi.mock("../../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: PressProps) => {
    harness.rows.set(props.label, props);
    return null;
  },
}));
vi.mock("./gitSheetComponents", () => ({
  SheetActionButton: (props: PressProps) => {
    harness.buttons.set(props.label, props);
    return null;
  },
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment-1", branch: null } }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: harness.cwd }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canChangeThreadBranch: true,
    onCheckoutSelectedThreadBranch: (name: string) => {
      harness.checkouts.push(name);
      return Promise.resolve(null);
    },
  }),
}));
vi.mock("../../../state/use-vcs-action-state", () => ({
  useVcsActionState: () => ({ currentLabel: null, hookName: null }),
}));
vi.mock("../../../state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: () => null },
}));
vi.mock("../../../state/atom-registry", () => ({ appAtomRegistry: { refresh: () => {} } }));
vi.mock("../../../state/session", () => ({ environmentSession: {} }));
vi.mock("../../../state/presentation", () => ({ useEnvironmentPresentation: () => ({}) }));
vi.mock("../../../state/pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("../../../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../../state/threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));
vi.mock("../../../state/vcs", () => ({
  vcsEnvironment: {
    branch: () => null,
    listRefs: ({ input }: { input: VcsListRefsInput }) => {
      const key = JSON.stringify(input);
      if (!harness.pages.has(key)) {
        harness.pages.set(
          key,
          Atom.make(harness.holds(input) ? AsyncResult.initial(true) : answer(input)),
        );
      }
      return harness.pages.get(key);
    },
  },
}));

const localRefs: VcsRef[] = [
  { name: "main", current: true, isDefault: true, isRemote: false, worktreePath: "/repo" },
  ...Array.from({ length: 104 }, (_, index) => ({
    name: `feature/branch-${String(index + 1).padStart(3, "0")}`,
    current: false,
    isDefault: false,
    isRemote: false,
    worktreePath: null,
  })),
];
const remoteRefs: VcsRef[] = Array.from({ length: 50 }, (_, index) => ({
  name: `origin/remote-${index + 1}`,
  current: false,
  isDefault: false,
  isRemote: true,
  worktreePath: null,
}));

// Pages refs the way the server's listRefs does: filtered by refKind, then sliced by cursor.
function listRefsPage(input: VcsListRefsInput): VcsListRefsResult {
  const refs =
    input.refKind === "local"
      ? localRefs
      : input.refKind === "remote"
        ? remoteRefs
        : [...localRefs, ...remoteRefs];
  const start = input.cursor ?? 0;
  const end = start + (input.limit ?? refs.length);
  return {
    refs: refs.slice(start, end),
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: end < refs.length ? end : null,
    totalCount: refs.length,
  };
}

// Live ref lists stay waiting for later changes after their first page arrives.
function answer(input: VcsListRefsInput) {
  return AsyncResult.success(listRefsPage(input), { waiting: true });
}

function setup() {
  harness.cwd = "/repo";
  harness.pages.clear();
  harness.rows.clear();
  harness.buttons.clear();
  harness.checkouts = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  const render = () => {
    harness.rows.clear();
    harness.buttons.clear();
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <GitBranchesSheet
            route={{ params: { environmentId: "environment-1", threadId: "thread-1" } }}
          />
        </RegistryContext.Provider>,
      ),
    );
  };
  render();
  return {
    registry,
    render,
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      harness.holds = () => false;
    },
  };
}

it("reaches local branches past the first page and checks them out", async () => {
  using screen = setup();
  expect(harness.rows.size).toBe(100);
  expect(harness.rows.has("feature/branch-100")).toBe(false);
  expect(harness.footer).toBeUndefined();

  harness.holds = (input) => input.cursor === 100;
  act(() => harness.buttons.get("Load more")!.onPress());
  screen.render();
  expect(harness.buttons.get("Load more")!.disabled).toBe(true);

  const [secondPageKey, secondPage] = [...harness.pages].find(
    ([key]) => (JSON.parse(key) as VcsListRefsInput).cursor === 100,
  )!;
  act(() =>
    screen.registry.set(
      secondPage as Atom.Writable<AsyncResult.AsyncResult<VcsListRefsResult>>,
      answer(JSON.parse(secondPageKey) as VcsListRefsInput),
    ),
  );
  screen.render();
  expect(harness.rows.size).toBe(105);
  expect([...harness.rows.keys()].some((name) => name.startsWith("origin/"))).toBe(false);
  expect(harness.buttons.has("Load more")).toBe(false);
  await act(async () => harness.rows.get("feature/branch-104")!.onPress());
  expect(harness.checkouts).toEqual(["feature/branch-104"]);
});

it("shows the saved branch list while local pages are unanswered", () => {
  harness.holds = (input) => input.refKind === "local";
  using _screen = setup();
  expect(harness.rows.has("main")).toBe(true);
  expect(harness.rows.size).toBe(100);
  expect(harness.footer).toBeUndefined();
  expect(harness.buttons.has("Load more")).toBe(false);
});
