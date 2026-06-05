import type { PluginUiPlacementPosition } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import {
  getActivePluginPlacementEntries,
  isPluginPlacementPathActive,
  pluginPlacementKey,
  resolvePluginPlacementRouteTarget,
} from "./pluginPlacements";
import { usePluginCatalog } from "./pluginHost";

function PluginSidebarPlacementMenu({
  position,
}: {
  readonly position: PluginUiPlacementPosition;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const catalog = usePluginCatalog();
  const placements = getActivePluginPlacementEntries(catalog, position);

  if (placements.length === 0) {
    return null;
  }

  return (
    <SidebarMenu>
      {placements.map((entry) => {
        const routeTarget = resolvePluginPlacementRouteTarget(entry);
        return (
          <SidebarMenuItem key={pluginPlacementKey(entry)}>
            <SidebarMenuButton
              size="sm"
              isActive={isPluginPlacementPathActive(entry, pathname)}
              render={<Link to={routeTarget.to} params={routeTarget.params} />}
            >
              <WorkflowIcon className="size-3.5" />
              <span className="flex-1 truncate text-left text-xs">{entry.placement.label}</span>
              {entry.placement.badgeCount && entry.placement.badgeCount > 0 ? (
                <span className="min-w-4 rounded-sm bg-warning/12 px-1 text-center text-[10px] font-medium text-warning-foreground">
                  {entry.placement.badgeCount}
                </span>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function PluginSidebarPrimaryPlacements() {
  const catalog = usePluginCatalog();
  const placements = getActivePluginPlacementEntries(catalog, "sidebar.primary");

  if (placements.length === 0) {
    return null;
  }

  return (
    <SidebarGroup className="px-2 py-1">
      <PluginSidebarPlacementMenu position="sidebar.primary" />
    </SidebarGroup>
  );
}

export function PluginSidebarFooterPlacements() {
  return <PluginSidebarPlacementMenu position="sidebar.footer" />;
}
