import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { SettingsListScreen } from "./SettingsRouteScreen";

const { Children, flags } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  flags: { cloud: false, personalTeam: false },
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" }, View: Children }));
vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
  useGT: () => (text: string) => text,
  useMessages: () => (text: string) => text,
}));
vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return { extra: { iosPersonalTeamBuild: flags.personalTeam } };
    },
  },
}));
vi.mock("../agent-awareness/androidNotifications", () => ({
  supportsAndroidAgentNotifications: () => false,
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  useUser: () => ({}),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => flags.cloud }));
vi.mock("../layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("../layout/workspace/navigation-tabs", () => ({
  useNavigationTabOrder: () => [],
  useHiddenNavigationTabs: () => [],
}));
vi.mock("../layout/workspace/navigation-tab-order", () => ({
  navigationCustomizationAvailable: () => false,
  overflowNavigationTabs: () => [],
}));
vi.mock("../layout/workspace/workspace-selection-store", () => ({}));
vi.mock("../layout/workspace/workspace-tab-navigation", () => ({}));
vi.mock("../layout/workspace/useSelectWorkspaceTab", () => ({ useSelectWorkspaceTab: () => null }));
vi.mock("../layout/workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeColumnLayoutMetrics: () => null }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("../../components/ui/Pane", () => ({}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => null,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [],
    projectGroups: [],
    selectedProjectKey: null,
  }),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", async () => ({
  SettingsSection: Children,
  SettingsSidebarContext: (await import("react")).createContext(null),
}));
vi.mock("./components/SettingsRow", () => ({
  SettingsRow: ({ label, target }: { label: string; target?: string }) => (
    <button data-target={target}>{label}</button>
  ),
}));

it.each([
  { cloud: false, personalTeam: false, visible: true },
  { cloud: true, personalTeam: false, visible: true },
  { cloud: false, personalTeam: true, visible: false },
])(
  "shows notifications with cloud=$cloud and personal team=$personalTeam: $visible",
  async (test) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    flags.cloud = test.cloud;
    flags.personalTeam = test.personalTeam;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() => root.render(<SettingsListScreen sidebar={false} selected={null} />));
      const row = container.querySelector('[data-target="SettingsNotifications"]');
      expect(row?.textContent).toBe(test.visible ? "Notifications" : undefined);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
