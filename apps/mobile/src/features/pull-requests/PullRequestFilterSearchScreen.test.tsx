import { RegistryContext } from "@effect/atom-react";
import type { PullRequestLabel } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  hostLabels: {
    "": [{ name: "triage", color: "cccccc" }],
    release: [{ name: "release-blocker", color: "d73a4a" }],
  } as Record<string, readonly PullRequestLabel[]>,
  setQuery: (_query: string) => {},
  workspaceQuery: "",
  focused: true,
  dispatch: vi.fn(),
  setControls: vi.fn(),
  goBack: vi.fn(),
}));

vi.mock("../layout/workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({
    state: { tabs: { pullRequests: { searchMode: "searching", query: harness.workspaceQuery } } },
    dispatch: harness.dispatch,
  }),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: harness.goBack, isFocused: () => harness.focused }),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    data: readonly string[];
    renderItem: (info: { item: string; index: number }) => ReactNode;
  }) => props.data.map((item, index) => <div key={item}>{props.renderItem({ item, index })}</div>),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/SelectionRow", () => ({
  SelectionRow: (props: {
    title: string;
    leading?: ReactNode;
    selected: boolean;
    onPress: () => void;
  }) => (
    <button aria-label={props.title} aria-pressed={props.selected} onClick={props.onPress}>
      {props.leading}
    </button>
  ),
}));
vi.mock("./PullRequestLabelDot", () => ({
  PullRequestLabelDot: (props: { color: string | null }) => <span data-color={props.color ?? ""} />,
}));
vi.mock("./PullRequestSearchSheet", () => ({
  PullRequestSearchSheet: (props: {
    onQueryChange: (query: string) => void;
    children: (list: { paddingBottom: number }) => ReactNode;
  }) => {
    harness.setQuery = props.onQueryChange;
    return props.children({ paddingBottom: 0 });
  },
}));
vi.mock("./usePullRequestListControls", () => ({
  usePullRequestListControls: () => ({
    controlsFor: () => ({ filters: { labels: [["release-blocker"]] } }),
    setControls: harness.setControls,
  }),
}));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("../../state/pull-requests", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const answer = Atom.family((query: string) =>
    Atom.make(
      AsyncResult.success({
        labels: harness.hostLabels[query] ?? [],
        authors: [],
        references: [],
        truncated: false,
      }),
    ),
  );
  return {
    composerPullRequests: {
      filterOptions: (target: { input: { query?: string } }) => answer(target.input.query ?? ""),
    },
  };
});

import { PullRequestFilterSearchScreen } from "./PullRequestFilterSearchScreen";

function mountAuthorSearch() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.workspaceQuery = "author:alice fix";
  harness.focused = true;
  vi.clearAllMocks();
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  const params = {
    kind: "authors" as const,
    environmentId: "env-1",
    environmentIds: [],
    suggestions: ["alice", "bob"],
  };
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <PullRequestFilterSearchScreen route={{ params }} />
      </RegistryContext.Provider>,
    ),
  );
  return {
    container,
    click(author: string) {
      act(() => container.querySelector<HTMLButtonElement>(`[aria-label="${author}"]`)!.click());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      harness.workspaceQuery = "";
      harness.focused = true;
      vi.unstubAllGlobals();
    },
  };
}

it.each([
  { choice: "bob", outcome: "Success" },
  { choice: "alice", outcome: "Success" },
  { choice: "bob", outcome: "Failure" },
  { choice: "alice", outcome: "Failure" },
] as const)(
  "reconciles a typed author after picking $choice with save $outcome",
  async ({ choice, outcome }) => {
    using screen = mountAuthorSearch();
    const save = Promise.withResolvers<{ _tag: "Success" | "Failure" }>();
    harness.setControls.mockReturnValue(save.promise);
    expect(screen.container.querySelector('[aria-label="alice"]')?.ariaPressed).toBe("true");
    screen.click(choice);
    expect(harness.setControls).toHaveBeenCalledWith("env-1", {
      filters: { labels: [["release-blocker"]], author: choice === "alice" ? undefined : "bob" },
    });
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.goBack).not.toHaveBeenCalled();
    await act(async () => {
      save.resolve({ _tag: outcome });
      await save.promise;
    });
    if (outcome === "Success") {
      expect(harness.dispatch).toHaveBeenCalledWith({
        type: "query",
        tab: "pullRequests",
        query: "fix",
      });
      expect(harness.goBack).toHaveBeenCalledOnce();
    } else {
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(harness.goBack).not.toHaveBeenCalled();
      expect(screen.container.querySelector('[aria-label="alice"]')?.ariaPressed).toBe("true");
    }
  },
);

it("ignores overlapping author taps until the pending save settles", async () => {
  using screen = mountAuthorSearch();
  const firstSave = Promise.withResolvers<{ _tag: "Success" | "Failure" }>();
  const secondSave = Promise.withResolvers<{ _tag: "Success" | "Failure" }>();
  harness.setControls
    .mockReturnValueOnce(firstSave.promise)
    .mockReturnValueOnce(secondSave.promise);

  screen.click("bob");
  screen.click("alice");
  screen.click("bob");
  expect(harness.setControls).toHaveBeenCalledTimes(1);

  await act(async () => {
    firstSave.resolve({ _tag: "Failure" });
    await firstSave.promise;
  });
  expect(harness.dispatch).not.toHaveBeenCalled();
  expect(harness.goBack).not.toHaveBeenCalled();

  screen.click("alice");
  expect(harness.setControls).toHaveBeenCalledTimes(2);
  await act(async () => {
    secondSave.resolve({ _tag: "Success" });
    await secondSave.promise;
  });
  expect(harness.dispatch).toHaveBeenCalledWith({
    type: "query",
    tab: "pullRequests",
    query: "fix",
  });
  expect(harness.goBack).toHaveBeenCalledOnce();
});

it("skips query dispatch and goBack when dismissed before an author save settles", async () => {
  using screen = mountAuthorSearch();
  const save = Promise.withResolvers<{ _tag: "Success" | "Failure" }>();
  harness.setControls.mockReturnValue(save.promise);

  screen.click("bob");
  expect(harness.setControls).toHaveBeenCalledOnce();
  harness.focused = false;

  await act(async () => {
    save.resolve({ _tag: "Success" });
    await save.promise;
  });
  expect(harness.dispatch).not.toHaveBeenCalled();
  expect(harness.goBack).not.toHaveBeenCalled();
});

it("keeps a selected host label's color after the search that found it is cleared", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  using _mounted = {
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      vi.unstubAllGlobals();
    },
  };
  const dot = () =>
    container.querySelector('[aria-label="release-blocker"] span')?.getAttribute("data-color");
  act(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <PullRequestFilterSearchScreen
          route={{
            params: {
              kind: "labels",
              environmentId: "env-1",
              environmentIds: ["env-1"],
              suggestions: [],
            },
          }}
        />
      </RegistryContext.Provider>,
    );
  });

  act(() => harness.setQuery("release"));
  expect(dot()).toBe("#d73a4a");
  act(() => harness.setQuery(""));
  expect(dot()).toBe("#d73a4a");
});
