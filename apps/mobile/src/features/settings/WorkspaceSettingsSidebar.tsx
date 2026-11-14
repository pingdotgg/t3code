import { use } from "react";
import {
  NavigationContainerRefContext,
  NavigationContext,
  NavigationRouteContext,
  useNavigationState,
} from "@react-navigation/native";

import { WorkspaceSidebarColumn } from "../layout/workspace/WorkspaceSidebarColumn";
import { SettingsListContent, SettingsListScreen } from "./SettingsRouteScreen";

export function WorkspaceSettingsSidebar(props: { readonly width: number }) {
  const navigation = use(NavigationContext);
  const container = use(NavigationContainerRefContext);
  const state = useNavigationState((state) => state);
  const index = state.routes.findIndex((route) => route.name === "Settings");
  const route = state.routes[index];
  if (!route) return null;
  return (
    <WorkspaceSidebarColumn width={props.width}>
      <SettingsListScreen sidebar selected={state.routes[index + 1]?.name ?? null}>
        {/* Root layouts can lack a screen navigation object; preserve the container fallback too.

            根布局可能没有页面导航对象；同时恢复容器回退，避免目录操作落到独立侧栏。 */}
        <NavigationContainerRefContext value={container}>
          <NavigationContext value={navigation}>
            <NavigationRouteContext value={route}>
              <SettingsListContent />
            </NavigationRouteContext>
          </NavigationContext>
        </NavigationContainerRefContext>
      </SettingsListScreen>
    </WorkspaceSidebarColumn>
  );
}
