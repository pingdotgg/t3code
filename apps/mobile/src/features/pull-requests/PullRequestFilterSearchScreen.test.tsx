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
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => {} }) }));
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
  SelectionRow: (props: { title: string; leading?: ReactNode }) => (
    <div aria-label={props.title}>{props.leading}</div>
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
    setControls: () => {},
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
