import type { ParamListBase, StackNavigationState } from "@react-navigation/native";
import {
  act,
  createContext,
  useImperativeHandle,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot } from "react-dom/client";
import type { Split as NativeSplit, SplitHostCommands } from "react-native-screens";
import { describe, expect, it, vi } from "vite-plus/test";

type HostProps = ComponentProps<typeof NativeSplit.Host> & {
  readonly ref?: Ref<SplitHostCommands>;
};
type ScreenProps = ComponentProps<typeof NativeSplit.Screen>;

const harness = vi.hoisted(() => ({
  hostProps: null as HostProps | null,
  screens: new Map<string, ScreenProps>(),
  show: vi.fn<(column: string) => void>(),
  hide: vi.fn<(column: string) => void>(),
  usesSplitView: false,
  openWorkspaceTab: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "27.3", isPad: false },
  StyleSheet: { absoluteFill: {}, flatten: (style: unknown) => style },
  View: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native-screens", () => ({
  Split: {
    Host: (allProps: HostProps) => {
      const { ref, children } = allProps;
      harness.hostProps = allProps;
      useImperativeHandle(
        ref,
        () => ({
          show: harness.show,
          hide: harness.hide,
        }),
        [],
      );
      return children;
    },
    Column: ({ children }: { children?: ReactNode }) => children,
    Stack: ({ children }: { children?: ReactNode }) => children,
    Screen: (props: ScreenProps) => {
      if (props.screenKey) harness.screens.set(props.screenKey, props);
      return props.children;
    },
    Inspector: () => null,
  },
}));
vi.mock("@react-navigation/native", () => ({
  createNavigatorFactory: () => () => null,
  NavigationContext: createContext(undefined),
  NavigationRouteContext: createContext(undefined),
  StackRouter: {},
  useNavigationBuilder: () => null,
}));
vi.mock("@react-navigation/native-stack", () => ({
  NativeStackView: () => null,
}));
vi.mock("../../state/use-thread-pr", () => ({
  withKnownPullRequestSummary: (identity: object) => identity,
}));
vi.mock("./workspace/workspace-selection-store", () => ({
  currentWorkspaceSelections: () => ({}),
  workspaceSelectionCheck: {
    thread: () => true,
    pullRequest: () => true,
    issue: () => true,
  },
}));
vi.mock("./workspace/workspace-tab-navigation", () => ({
  workspaceTabColumns: () => false,
  workspaceTabPage: () => undefined,
}));
vi.mock("./workspace/WorkspaceTabsContext", () => ({
  WorkspaceTabsProvider: ({ children }: { children?: ReactNode }) => children,
  useWorkspaceTabs: () => ({
    state: { selectedTab: "threads" },
    settingsOpen: false,
    isTabActive: (tab: string) => tab === "threads",
  }),
}));
vi.mock("./workspace/WorkspaceNativeTabs.ios", () => ({
  WorkspaceNativeTabs: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("./workspace/WorkspaceTabDock", () => ({
  WorkspaceTabDock: () => null,
}));
vi.mock("./workspace/useWorkspaceCompose", () => ({
  useWorkspaceCompose: () => null,
}));
vi.mock("../../native/native-layout-metrics", () => ({
  useDeviceType: () => (harness.usesSplitView ? "duo-unfolded" : "duo-folded"),
  useNativeLayoutMetrics: () => null,
}));
vi.mock("./AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: {
      variant: harness.usesSplitView ? "expanded" : "compact",
      usesSplitView: harness.usesSplitView,
      listPaneWidth: harness.usesSplitView ? 320 : null,
      shellPadding: 0,
    },
    setPrimarySidebarVisible: vi.fn(),
    toggleAuxiliaryPane: vi.fn(),
    startNewTask: vi.fn(),
    openWorkspaceTab: harness.openWorkspaceTab,
    nativeInspectorWidth: 320,
    setNativeInspectorWidth: vi.fn(),
  }),
  useWorkspacePaneState: () => ({
    panes: {
      primarySidebarVisible: harness.usesSplitView,
      primarySidebarWhenExpanded: true,
    },
    sidebarByOrientation: null,
  }),
}));
vi.mock("./workspace-pane-divider", () => ({ WorkspacePaneDivider: () => null }));
vi.mock("./WorkspaceEmptyDetail", () => ({ WorkspaceEmptyDetail: () => null }));
vi.mock("../../native/NativeColumnContent.ios", () => ({
  NativeColumnContent: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../native/createV5StackNavigator.ios", () => ({
  modalEnvelopeOptions: (options: object) => options,
  V5CardStackView: () => null,
  V5StackView: () => null,
}));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsReady: () => true,
  useNativeWorkspaceColumnsSupported: () => true,
}));
vi.mock("../../native/V5StackHeader.ios", () => ({ V5StackHeader: () => null }));
vi.mock("./inspector-host", () => ({ InspectorColumnScreens: () => null }));
vi.mock("./useWorkspaceSidebarHeaderItem", () => ({
  useWorkspaceSidebarHeaderItem: () => null,
}));
vi.mock("../settings/settings-navigation", () => ({
  isSettingsRoute: (name: string) => name.startsWith("Settings"),
  settingsOpenIn: () => false,
}));
vi.mock("../issues/issueParams", () => ({
  selectedIssueKeyOf: () => null,
}));

import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { WorkspaceColumns } from "./createWorkspaceStackNavigator.ios";

type Route = StackNavigationState<ParamListBase>["routes"][number];
type ColumnsProps = ComponentProps<typeof WorkspaceColumns>;

const home: Route = { key: "home", name: "Home" };
const threadRoute = (key: string, threadId: string): Route => ({
  key,
  name: "Thread",
  params: { environmentId: "env-1", threadId },
});

function createNavState(routes: readonly Route[]): StackNavigationState<ParamListBase> {
  return {
    key: "root",
    type: "stack",
    stale: false,
    index: routes.length - 1,
    routeNames: ["Home", "Thread", "PullRequest", "Issue"],
    routes: [...routes],
    preloadedRoutes: [],
  };
}

function fireScreen(
  key: string,
  event: "onWillAppear" | "onDidAppear" | "onWillDisappear" | "onDidDisappear",
) {
  const handler = harness.screens.get(key)?.[event] as (() => void) | undefined;
  if (!handler) throw new Error(`Missing ${event} for ${key}`);
  act(() => handler());
}

function mountColumns(initial: {
  readonly routes: readonly Route[];
  readonly usesSplitView?: boolean;
  readonly active?: boolean;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.hostProps = null;
  harness.screens.clear();
  harness.show.mockReset();
  harness.hide.mockReset();
  harness.openWorkspaceTab.mockReset();
  harness.usesSplitView = initial.usesSplitView ?? false;

  let currentState = createNavState(initial.routes);
  let active = initial.active ?? true;
  const dispatch = vi.fn();
  const navigation = {
    getState: () => currentState,
    emit: vi.fn(),
    dispatch,
  };
  const makeDescriptor = (route: Route) => ({
    route,
    navigation,
    options: {},
    render: () => null,
  });

  const root = createRoot(document.createElement("div"));
  const renderWith = (next?: {
    readonly routes?: readonly Route[];
    readonly usesSplitView?: boolean;
    readonly active?: boolean;
  }) => {
    if (next?.routes) currentState = createNavState(next.routes);
    if (next?.usesSplitView !== undefined) harness.usesSplitView = next.usesSplitView;
    if (next?.active !== undefined) active = next.active;
    const detail = currentState.routes.filter((route) => route.name !== "Home");
    const descriptors = Object.fromEntries(
      currentState.routes.map((route) => [route.key, makeDescriptor(route)]),
    );
    act(() =>
      root.render(
        <NativeWorkspaceTabActivityContext
          value={{ active, isActive: () => active, headerOnly: false }}
        >
          <WorkspaceColumns
            {...({
              state: currentState,
              navigation,
              descriptors,
              describe: makeDescriptor,
              primary: home,
              detail,
            } as unknown as ColumnsProps)}
          />
        </NativeWorkspaceTabActivityContext>,
      ),
    );
  };

  renderWith();

  return {
    renderWith,
    dispatch,
    unmount: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("WorkspaceColumns collapsed split selection", () => {
  it("opens the secondary column when selecting another thread while Home is visible and detail already holds a thread", () => {
    const first = threadRoute("thread-1", "thread-a");
    const columns = mountColumns({ routes: [home, first], usesSplitView: false });
    try {
      fireScreen(home.key, "onDidAppear");
      harness.show.mockClear();

      // Selecting another thread reuses the same route key and swaps params in place.
      columns.renderWith({ routes: [home, threadRoute("thread-1", "thread-b")] });
      expect(harness.show).toHaveBeenCalledWith("secondary");
    } finally {
      columns.unmount();
    }
  });

  it("opens the newly selected thread once Home finishes appearing after a mid-Back tap", () => {
    const first = threadRoute("thread-1", "thread-a");
    const columns = mountColumns({ routes: [home, first], usesSplitView: false });
    try {
      fireScreen(first.key, "onDidAppear");
      // Native Back begins from Thread A toward Home.
      fireScreen(first.key, "onWillDisappear");
      fireScreen(home.key, "onWillAppear");

      // User taps Thread B before Home.onDidAppear reaches JS.
      const second = threadRoute("thread-2", "thread-b");
      columns.renderWith({ routes: [home, second] });
      expect(harness.show).not.toHaveBeenCalled();

      // Back finishes: Thread A is already gone so nothing pops, and Thread B opens.
      fireScreen(first.key, "onDidDisappear");
      fireScreen(home.key, "onDidAppear");
      expect(columns.dispatch).not.toHaveBeenCalled();
      expect(harness.show).toHaveBeenCalledWith("secondary");
    } finally {
      columns.unmount();
    }
  });

  it("shows the detail column when Home appears first for an already-selected thread", () => {
    const first = threadRoute("thread-1", "thread-a");
    const columns = mountColumns({ routes: [home, first], usesSplitView: false });
    try {
      fireScreen(home.key, "onDidAppear");
      expect(columns.dispatch).not.toHaveBeenCalled();
      expect(harness.show).toHaveBeenCalledWith("secondary");
    } finally {
      columns.unmount();
    }
  });

  it("retries showing secondary if an earlier show command did not present it", () => {
    const columns = mountColumns({ routes: [home], usesSplitView: false });
    try {
      fireScreen(home.key, "onDidAppear");

      // First tap calls show("secondary"), but UIKit drops it (no appearance events arrive).
      columns.renderWith({ routes: [home, threadRoute("thread-1", "thread-a")] });
      expect(harness.show).toHaveBeenCalledTimes(1);
      expect(harness.show).toHaveBeenLastCalledWith("secondary");

      // Second tap reuses the route key with new params and must retry show("secondary").
      columns.renderWith({ routes: [home, threadRoute("thread-1", "thread-b")] });
      expect(harness.show).toHaveBeenCalledTimes(2);
      expect(harness.show).toHaveBeenLastCalledWith("secondary");
    } finally {
      columns.unmount();
    }
  });

  it("still tracks collapsed Back on a tab that folded while inactive", () => {
    const first = threadRoute("thread-1", "thread-a");
    const columns = mountColumns({ routes: [home, first], usesSplitView: true, active: false });
    try {
      // Duo folds while this tab is inactive, so onCollapse never fires on it.
      columns.renderWith({ routes: [home, first], usesSplitView: false, active: false });
      expect(harness.show).not.toHaveBeenCalled();

      // User returns to this tab and swipes Back from the thread.
      columns.renderWith({ routes: [home, first], usesSplitView: false, active: true });
      fireScreen(first.key, "onDidAppear");
      fireScreen(first.key, "onWillDisappear");
      fireScreen(home.key, "onWillAppear");
      fireScreen(first.key, "onDidDisappear");
      fireScreen(home.key, "onDidAppear");

      expect(columns.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "POP", payload: { count: 1 } }),
      );
    } finally {
      columns.unmount();
    }
  });

  it("recovers when an expanded split collapses with Home remaining visible", () => {
    const first = threadRoute("thread-1", "thread-a");
    const columns = mountColumns({ routes: [home, first], usesSplitView: true });
    try {
      fireScreen(home.key, "onDidAppear");
      fireScreen(first.key, "onDidAppear");

      // UIKit collapses leaving Home visible (detail disappears, Home does not re-emit didAppear).
      act(() => harness.hostProps?.onCollapse?.({} as never));
      columns.renderWith({ routes: [home, first], usesSplitView: false });
      fireScreen(first.key, "onDidDisappear");
      harness.show.mockClear();

      // Tapping another thread must open the secondary column.
      columns.renderWith({ routes: [home, threadRoute("thread-1", "thread-b")] });
      expect(harness.show).toHaveBeenCalledWith("secondary");
    } finally {
      columns.unmount();
    }
  });

  it("reconciles back to primary when a pending detail push is cleared before didAppear", () => {
    const columns = mountColumns({ routes: [home], usesSplitView: false });
    try {
      fireScreen(home.key, "onDidAppear");

      // User opens a thread and UIKit begins pushing the secondary column.
      const first = threadRoute("thread-1", "thread-a");
      columns.renderWith({ routes: [home, first] });
      expect(harness.show).toHaveBeenLastCalledWith("secondary");
      fireScreen(first.key, "onWillAppear");
      harness.show.mockClear();

      // Keyboard Back or reselecting the Threads tab clears activeDetail mid-push.
      columns.renderWith({ routes: [home] });
      expect(harness.show).toHaveBeenCalledWith("primary");

      // Even if UIKit ignored show("primary") mid-transition and finished the push,
      // the detail's didAppear must still reconcile back to primary.
      harness.show.mockClear();
      fireScreen(first.key, "onDidAppear");
      expect(harness.show).toHaveBeenCalledWith("primary");

      // Once primary settles, no extra show command fires.
      harness.show.mockClear();
      fireScreen(home.key, "onDidAppear");
      expect(harness.show).not.toHaveBeenCalled();
    } finally {
      columns.unmount();
    }
  });
});
