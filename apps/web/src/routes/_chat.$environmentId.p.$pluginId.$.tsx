import { useAtomValue } from "@effect/atom-react";
import { PluginId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { createElement, type FunctionComponent } from "react";
import type { PluginRouteComponentProps } from "@t3tools/plugin-sdk-web";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import {
  PluginSurfaceErrorBoundary,
  pluginUiRegistryAtom,
  resolvePluginRouteRegistration,
} from "../plugins/PluginUiHost";

function splatFromParams(params: Record<string, unknown>): string {
  const value = params._splat ?? params["*"];
  return typeof value === "string" ? value : "";
}

function PluginRouteNotFound() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Plugin page not found</EmptyTitle>
          <EmptyDescription>The plugin route is not registered.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function PluginRouteView() {
  const params = Route.useParams();
  const snapshot = useAtomValue(pluginUiRegistryAtom);
  const pluginId = PluginId.make(params.pluginId);
  const route = resolvePluginRouteRegistration(snapshot, pluginId, splatFromParams(params));

  if (!route) {
    return <PluginRouteNotFound />;
  }

  // Render the plugin component as its OWN React element (createElement), not
  // by calling it as a function: a function call would run the plugin's hooks
  // on this route's fiber and break the Rules of Hooks when the resolved
  // component changes. As an element it gets its own fiber and the error
  // boundary actually wraps the mounted component.
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <PluginSurfaceErrorBoundary label={`route:${route.pluginId}:${route.path}`}>
        {createElement(route.component as FunctionComponent<PluginRouteComponentProps>, {
          pluginId: route.pluginId,
          path: route.path,
        })}
      </PluginSurfaceErrorBoundary>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/p/$pluginId/$")({
  component: PluginRouteView,
});
