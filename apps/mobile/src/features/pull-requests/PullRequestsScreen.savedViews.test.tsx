// @vitest-environment jsdom
import { act, useEffect, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  PullRequestListControls,
  PullRequestSavedView,
} from "../../persistence/mobile-preferences";
import type { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import type { ListFilterMenu } from "../workspace/ListFilterMenu";

const fixture = vi.hoisted(() => ({
  controls: {
    involvement: "authored",
    state: "closed",
    filters: {},
    sort: "updated",
  } as PullRequestListControls,
  workspace: null as ReturnType<typeof useWorkspaceTabs>,
  applyView: vi.fn<(view: PullRequestSavedView) => Promise<void>>(),
  scroll: vi.fn(),
  alert: vi.fn(),
  views: [] as ReadonlyArray<PullRequestSavedView>,
  configs: new Map<string, never>(),
  list: { entries: [], data: { viewers: {}, localSearchHosts: new Set(), errors: [] } },
}));

vi.mock("@legendapp/list/react-native", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    LegendList: ({
      ref,
      ListHeaderComponent,
    }: {
      ref: Ref<{ scrollToOffset: typeof fixture.scroll }>;
      ListHeaderComponent: ReactNode;
    }) => {
      useImperativeHandle(ref, () => ({ scrollToOffset: fixture.scroll }));
      return ListHeaderComponent;
    },
  };
});
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => fixture.configs }));
vi.mock("react-native", () => ({
  View: "div",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  RefreshControl: "RefreshControl",
  Platform: { OS: "ios" },
  Keyboard: { dismiss: vi.fn() },
  Alert: { alert: fixture.alert },
}));
vi.mock("react-native-screens", () => ({ ScrollViewMarker: "ScrollViewMarker" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0 }),
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/EmptyState", () => ({ EmptyState: "EmptyState" }));
vi.mock("../../native/v5-workspace-context", async () => ({
  NativePrimaryColumnContext: (await import("react")).createContext(null),
}));
vi.mock("../../state/workspace", () => ({ useWorkspaceState: () => ({ environments: [] }) }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("./PullRequestListRow", () => ({ PullRequestListRow: "PullRequestListRow" }));
vi.mock("./PullRequestListFilters", () => ({
  PullRequestListFilters: ({ savedViewsMenu }: { savedViewsMenu: ReactNode }) => savedViewsMenu,
}));
vi.mock("../workspace/ListFilterMenu", () => ({
  ListFilterMenu: (props: Parameters<typeof ListFilterMenu>[0]) => (
    <button
      aria-label={props.accessibilityLabel}
      disabled={props.actions.every((action) => action.attributes?.disabled)}
      onClick={() => props.onSelect("apply:review")}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("./usePullRequestList", () => ({ usePullRequestList: () => fixture.list }));
vi.mock("./usePullRequestListActions", () => ({ usePullRequestListActions: () => ({}) }));
vi.mock("../workspace/useAndroidWorkspaceSelection", () => ({
  useAndroidWorkspaceSelection: () => vi.fn(),
}));
vi.mock("../../components/ConfirmDialogHost", () => ({ showTextInputDialog: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "new-view" }));
vi.mock("./usePullRequestListControls", () => ({
  usePullRequestListControls: () => ({
    environmentId: null,
    controlsFor: () => fixture.controls,
    applyView: fixture.applyView,
  }),
  usePullRequestSavedViews: () => ({ views: fixture.views, ready: true, update: vi.fn() }),
}));

import { PullRequestsScreen } from "./PullRequestsScreen";
import {
  useWorkspaceTabs as readWorkspace,
  WorkspaceTabsProvider,
} from "../workspace/WorkspaceTabsContext";

let renderer: Root;
let container: HTMLDivElement;
function Scene() {
  const workspace = readWorkspace();
  useEffect(() => {
    fixture.workspace = workspace;
  }, [workspace]);
  return <PullRequestsScreen />;
}
const view: PullRequestSavedView = {
  id: "review",
  name: "Review queue",
  environmentId: null,
  query: "",
  controls: { involvement: "reviewing", state: "open", filters: {}, sort: "updated" },
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.controls = { involvement: "authored", state: "closed", filters: {}, sort: "updated" };
  fixture.views = [view];
  fixture.applyView.mockReset();
  fixture.alert.mockReset();
  fixture.scroll.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
  await act(() => {
    renderer.render(
      <WorkspaceTabsProvider>
        <Scene />
      </WorkspaceTabsProvider>,
    );
  });
  await act(() => {
    const { dispatch } = fixture.workspace!;
    dispatch({ type: "scroll", tab: "pullRequests", offset: 640 });
    dispatch({ type: "search", tab: "pullRequests" });
    dispatch({ type: "query", tab: "pullRequests", query: "existing query" });
    dispatch({ type: "scroll", tab: "pullRequests", offset: 80 });
  });
});

afterEach(async () => {
  await act(() => renderer.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function menu(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[aria-label="Saved pull request views"]')!;
}

it("waits for preferences before changing the search, and keeps an empty-query view at the top", async () => {
  let finish!: () => void;
  const persistence = new Promise<void>((resolve) => {
    finish = resolve;
  });
  fixture.applyView.mockImplementation(async (saved) => {
    await persistence;
    fixture.controls = saved.controls;
  });
  await act(() => menu().click());
  expect(fixture.workspace!.state.tabs.pullRequests.query).toBe("existing query");
  expect(fixture.scroll).not.toHaveBeenCalled();
  expect(menu().disabled).toBe(true);

  await act(async () => {
    finish();
    await persistence;
  });
  expect(fixture.workspace!.state.tabs.pullRequests).toEqual({
    query: "",
    searchMode: "resting",
    scrollOffset: 0,
    searchEntryOffset: 0,
  });
  expect(fixture.scroll).toHaveBeenCalled();
  expect(fixture.scroll.mock.calls.every(([input]) => input.offset === -24)).toBe(true);
  expect(menu().textContent).toBe("Review queue");
});

it.each(["", "saved query"])(
  "preserves search and scroll when applying query %j fails",
  async (query) => {
    fixture.views = [{ ...view, query }];
    await act(() =>
      renderer.render(
        <WorkspaceTabsProvider>
          <Scene />
        </WorkspaceTabsProvider>,
      ),
    );
    const before = fixture.workspace!.state.tabs.pullRequests;
    fixture.applyView.mockRejectedValue(new Error("storage unavailable"));
    await act(() => menu().click());
    expect(fixture.workspace!.state.tabs.pullRequests).toEqual(before);
    expect(fixture.scroll).not.toHaveBeenCalled();
    expect(fixture.alert).toHaveBeenCalledWith("Could not apply PR view", expect.any(String));
    expect(menu().textContent).toBe("Views");
    expect(menu().disabled).toBe(false);
  },
);
