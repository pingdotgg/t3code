import { act, type ContextType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  NavigationContainerRefContext,
  NavigationContext,
  type NavigationState,
} from "@react-navigation/native";

vi.mock("@react-navigation/native", async () => {
  // Resolve native's own core so the test exercises its real navigation-context fallback.
  //
  // 使用 native 实际依赖的 core，验证真实的导航上下文回退行为。
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const core = createRequire(require.resolve("@react-navigation/native")).resolve(
    "@react-navigation/core",
  );
  const actual = await import(core);
  return {
    ...actual,
    useNavigationState: (select: (state: NavigationState) => unknown) =>
      select(actual.useNavigation().getState()),
  };
});
vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    select: (values: { ios?: unknown; default?: unknown }) => values.ios ?? values.default,
  },
  I18nManager: { isRTL: false },
  Linking: {},
}));
vi.mock("../../components/ui/ListRow", () => ({
  ListRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({ ListRowLayout: () => null }));
vi.mock("../../components/ui/RowPressable", () => ({ RowPressable: () => null }));
vi.mock("./components/SettingsSection", async () => {
  const { createContext } = await import("react");
  return { SettingsSidebarContext: createContext(null) };
});
vi.mock("./SettingsRouteScreen", async () => {
  const { SettingsRow } = await import("./components/SettingsRow");
  return {
    SettingsListScreen: ({ children }: { children: ReactNode }) => children,
    SettingsListContent: () => (
      <SettingsRow icon={undefined} label="General" target="SettingsOrganization" />
    ),
  };
});
vi.mock("../layout/workspace/WorkspaceSidebarColumn", async () => {
  const { NavigationContainerRefContext, NavigationContext } =
    await import("@react-navigation/native");
  return {
    WorkspaceSidebarColumn: ({ children }: { children: ReactNode }) => {
      const standalone = {
        getState: () => ({
          key: "standalone",
          routes: [{ key: "standalone-route", name: "Standalone" }],
          index: 0,
        }),
        getParent: () => undefined,
        dispatch: () => {},
      };
      return (
        <NavigationContainerRefContext
          value={standalone as unknown as ContextType<typeof NavigationContainerRefContext>}
        >
          <NavigationContext value={undefined}>{children}</NavigationContext>
        </NavigationContainerRefContext>
      );
    },
  };
});

import { WorkspaceSettingsSidebar } from "./WorkspaceSettingsSidebar";

describe("legacy Settings sidebar navigation", () => {
  it.each([false, true])(
    "opens General in the workspace with a screen navigation context of %s",
    (screenContext) => {
      const state = {
        key: "workspace",
        type: "stack",
        stale: false,
        index: 2,
        routeNames: ["Home", "Settings", "SettingsEnvironments", "SettingsOrganization"],
        routes: [
          { key: "home", name: "Home" },
          { key: "settings", name: "Settings" },
          { key: "environments", name: "SettingsEnvironments" },
        ],
      };
      const dispatch = vi.fn();
      const navigation = {
        getState: () => state,
        getRootState: () => state,
        getParent: () => undefined,
        addListener: () => () => {},
        dispatch,
      };
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        act(() =>
          root.render(
            <NavigationContainerRefContext
              value={navigation as unknown as ContextType<typeof NavigationContainerRefContext>}
            >
              <NavigationContext
                value={
                  screenContext
                    ? (navigation as unknown as ContextType<typeof NavigationContext>)
                    : undefined
                }
              >
                <WorkspaceSettingsSidebar width={320} />
              </NavigationContext>
            </NavigationContainerRefContext>,
          ),
        );
        act(() => container.querySelector("button")!.click());
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "RESET",
            target: "workspace",
            payload: expect.objectContaining({
              routeNames: state.routeNames,
              routes: [
                state.routes[0],
                state.routes[1],
                { name: "SettingsOrganization", params: undefined },
              ],
            }),
          }),
        );
      } finally {
        act(() => root.unmount());
      }
    },
  );
});
