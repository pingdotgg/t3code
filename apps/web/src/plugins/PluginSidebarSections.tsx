import { useAtomValue } from "@effect/atom-react";
import { createElement, type FunctionComponent } from "react";
import type { PluginSidebarSectionRenderProps } from "@t3tools/plugin-sdk-web";

import { useActiveEnvironmentId } from "../state/entities";
import {
  PluginSurfaceErrorBoundary,
  pluginUiRegistryAtom,
  type PluginUiRegistrySnapshot,
} from "./PluginUiHost";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "../components/ui/sidebar";

export function getVisiblePluginSidebarSections(snapshot: PluginUiRegistrySnapshot) {
  return snapshot.sidebarSections;
}

export function PluginSidebarSections() {
  const snapshot = useAtomValue(pluginUiRegistryAtom);
  const environmentId = useActiveEnvironmentId();
  const sections = getVisiblePluginSidebarSections(snapshot);

  if (sections.length === 0) {
    return null;
  }

  return (
    <>
      {sections.map((section) => {
        const routeBasePath =
          environmentId === null ? null : `/${environmentId}/p/${section.pluginId}`;
        return (
          <SidebarGroup key={`${section.pluginId}:${section.id}`} className="px-2 py-2">
            <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <PluginSurfaceErrorBoundary label={`sidebar:${section.pluginId}:${section.id}`}>
                  {createElement(
                    section.render as FunctionComponent<PluginSidebarSectionRenderProps>,
                    { pluginId: section.pluginId, environmentId, routeBasePath },
                  )}
                </PluginSurfaceErrorBoundary>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        );
      })}
    </>
  );
}
