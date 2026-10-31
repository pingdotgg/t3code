import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SearchBarCommands } from "react-native-screens";
import { expect, it, vi } from "vite-plus/test";

const searchBar = vi.hoisted(() => ({
  setText: vi.fn(),
  setActive: vi.fn(),
  focus: vi.fn(),
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
// On a phone the Settings route sits above Home and only selects what Home draws, so Home,
// which hosts this toolbar, is not the focused route.
vi.mock("@react-navigation/native", () => {
  const state = { index: 1, routes: [{ name: "Home" }, { name: "Settings" }] };
  return {
    useIsFocused: () => false,
    useFocusEffect: () => {},
    useNavigationState: <T,>(selector: (value: typeof state) => T) => selector(state),
  };
});
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: true }));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: (props: {
    options: { headerSearchBarOptions?: { ref: { current: unknown } } };
  }) => {
    const ref = props.options.headerSearchBarOptions?.ref;
    if (ref) ref.current = searchBar as unknown as SearchBarCommands;
    return null;
  },
}));
vi.mock("../../components/ui/Toolbar", () => ({
  Toolbar: Object.assign(() => null, {
    Button: () => null,
    Spacer: () => null,
    SearchBarSlot: () => null,
  }),
}));
vi.mock("../../state/active-new-task", () => ({ useActiveNewTask: () => null }));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({ useHardwareKeyboardCommand: () => {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { primarySidebarVisible: false },
    togglePrimarySidebar: () => {},
  }),
}));
vi.mock("./useSystemWorkspaceTabBar", () => ({
  useSidebarWorkspaceTabs: () => null,
  useFloatingWorkspaceTabs: () => false,
}));
vi.mock("./WorkspaceSectionToolbar", () => ({ WorkspaceTabToolbarButtons: () => null }));
vi.mock("./WorkspaceTabsContext", () => {
  const tab = { query: "", searchMode: "resting", scrollOffset: 0, searchEntryOffset: 0 };
  const workspace = {
    settingsOpen: true,
    state: {
      selectedTab: "threads",
      tabs: {
        threads: tab,
        pullRequests: tab,
        usage: tab,
        settings: { ...tab, query: "version", searchMode: "expanded" },
      },
    },
    isTabActive: () => true,
    dispatch: () => {},
    getScrollOffset: () => 0,
    recordScrollOffset: () => {},
  };
  return { useWorkspaceTabs: () => workspace };
});

import { WorkspaceToolbar } from "./WorkspaceToolbar.ios";

it("puts a submitted Settings search back in the phone's header when Settings reopens", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    act(() => root.render(<WorkspaceToolbar onNewTask={() => {}} />));
    act(() => vi.advanceTimersToNextFrame());
    // The list is still filtered by "version", so the native field must show it, not collapse.
    expect(searchBar.setText).toHaveBeenCalledWith("version");
    expect(searchBar.setActive).toHaveBeenCalledWith(true);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
