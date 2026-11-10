import { act, createContext, use, useReducer, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { SearchBarCommands, SearchBarProps } from "react-native-screens";
import { expect, it, vi } from "vite-plus/test";

import { NativeWorkspaceTabActivityContext } from "../../../native/v5-workspace-context";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  type WorkspaceTabsState,
} from "./workspace-tabs-state";

const host = vi.hoisted(() => ({
  focused: true,
  searchBar: undefined as SearchBarProps | undefined,
  observeThreads: vi.fn(),
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useIsFocused: () => host.focused,
    useFocusEffect: (effect: () => void | (() => void)) => {
      const focused = host.focused;
      useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
  };
});
vi.mock("../../../state/active-new-task", () => ({ useActiveNewTask: () => null }));
vi.mock("../../../components/ui/Toolbar", () => {
  const Empty = ({ children }: { children?: ReactNode }) => children;
  return {
    Toolbar: Object.assign(Empty, {
      Button: () => null,
      Spacer: () => null,
      SearchBarSlot: () => null,
    }),
  };
});
vi.mock("../../../lib/device-type", () => ({ isDuoDevice: () => false }));
vi.mock("../../../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: true }));
vi.mock("../../keyboard/hardwareKeyboardCommands", () => ({
  useHardwareKeyboardCommand: () => {},
}));
vi.mock("../AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: {}, togglePrimarySidebar: () => {} }),
  useWorkspacePaneState: () => ({ panes: {} }),
}));
vi.mock("../../settings/components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ title: "", icon: "", items: [] }),
}));
vi.mock("./useSystemWorkspaceTabBar", () => ({
  useFloatingWorkspaceTabs: () => false,
  useSidebarWorkspaceTabs: () => "picker",
}));
vi.mock("./WorkspaceSectionToolbar", () => ({ WorkspaceTabToolbarButtons: () => null }));
vi.mock("./WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => use(Workspace) }));
vi.mock("../../../native/StackHeader", () => ({
  NativeStackScreenOptions: ({
    options,
  }: {
    options: { headerSearchBarOptions?: SearchBarProps & { ref?: { current: unknown } } };
  }) => {
    host.searchBar = options.headerSearchBarOptions;
    if (host.searchBar?.ref) host.searchBar.ref.current = nativeSearch;
    return null;
  },
}));

import { WorkspaceToolbar } from "./WorkspaceToolbar";

const Workspace = createContext<unknown>(null);
const nativeSearch = {
  setText: vi.fn(),
  setActive: vi.fn(),
  focus: vi.fn(),
  blur: vi.fn(),
  clearText: vi.fn(),
  cancelSearch: vi.fn(),
  toggleCancelButton: vi.fn(),
} satisfies SearchBarCommands;

function Harness(props: { readonly initial: WorkspaceTabsState; readonly tabActive: boolean }) {
  const [state, dispatch] = useReducer(workspaceTabsReducer, props.initial);
  host.observeThreads(state.tabs.threads);
  return (
    <NativeWorkspaceTabActivityContext value={{ active: props.tabActive, isActive: () => true }}>
      <Workspace
        value={{
          state,
          dispatch,
          settingsOpen: false,
          isTabActive: (tab: string) => tab === state.selectedTab,
          getScrollOffset: () => 0,
          recordScrollOffset: () => {},
        }}
      >
        <WorkspaceToolbar onNewTask={() => {}} />
      </Workspace>
    </NativeWorkspaceTabActivityContext>
  );
}

it("clears the query when search blurs without Search asking to keep it", () => {
  host.focused = true;
  host.searchBar = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  const flushFrames = () => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  };

  let initial = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
  initial = workspaceTabsReducer(initial, { type: "query", query: "zzz" });
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<Harness initial={initial} tabActive />);
  });
  act(flushFrames);
  nativeSearch.setText.mockClear();
  nativeSearch.setActive.mockClear();

  act(() => {
    host.searchBar?.onBlur?.({} as never);
  });
  act(flushFrames);

  expect(host.observeThreads).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: "", searchMode: "resting" }),
  );
  expect(nativeSearch.setText).not.toHaveBeenCalled();
  expect(nativeSearch.setActive).not.toHaveBeenCalled();

  act(() => root.unmount());
});

it("keeps the query when Search dismisses the keyboard", () => {
  host.focused = true;
  host.searchBar = undefined;
  host.observeThreads.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };

  let initial = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
  initial = workspaceTabsReducer(initial, { type: "query", query: "zzz" });
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<Harness initial={initial} tabActive />);
  });

  act(() => {
    host.searchBar?.onSearchButtonPress?.({ nativeEvent: { text: "zzz" } } as never);
    host.searchBar?.onBlur?.({} as never);
  });

  expect(host.observeThreads).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: "zzz", searchMode: "expanded" }),
  );

  act(() => root.unmount());
});
