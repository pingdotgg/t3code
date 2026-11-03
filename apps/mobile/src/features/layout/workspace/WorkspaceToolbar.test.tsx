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
  useAdaptiveWorkspaceLayout: () => ({ layout: {}, panes: {}, togglePrimarySidebar: () => {} }),
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

it("restores a retained query when search reappears, but not after the blur of its X", () => {
  host.focused = true;
  host.searchBar = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const frames = new Map<number, FrameRequestCallback>();
  let lastFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++lastFrame, callback);
    return lastFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  const nextFrame = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  const clearCommands = () => {
    for (const command of Object.values(nativeSearch)) command.mockClear();
  };
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const initial = workspaceTabsReducer(
    workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" }),
    { type: "query", query: "alpha" },
  );
  const render = (tabActive = true) =>
    act(() => root.render(<Harness initial={initial} tabActive={tabActive} />));

  render();
  nextFrame();
  expect(nativeSearch.setText).toHaveBeenLastCalledWith("alpha");
  clearCommands();

  // iOS 27's X reports only a blur; UIKit is still dismissing the field.
  act(() => host.searchBar?.onBlur?.({} as never));
  nextFrame();
  expect(nativeSearch.setText).not.toHaveBeenCalled();
  expect(nativeSearch.setActive).not.toHaveBeenCalled();

  // Back from a thread, and back to this tab, keep showing the query that filters the list.
  host.focused = false;
  render();
  host.focused = true;
  render();
  nextFrame();
  expect(nativeSearch.setText).toHaveBeenLastCalledWith("alpha");
  expect(nativeSearch.setActive).toHaveBeenLastCalledWith(true);
  expect(nativeSearch.focus).not.toHaveBeenCalled();
  clearCommands();
  render(false);
  render(true);
  nextFrame();
  expect(nativeSearch.setText).toHaveBeenLastCalledWith("alpha");
  expect(nativeSearch.setActive).toHaveBeenLastCalledWith(true);
});
