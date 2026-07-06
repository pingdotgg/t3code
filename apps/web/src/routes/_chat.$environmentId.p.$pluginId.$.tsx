import { useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { createElement, type FunctionComponent } from "react";
import type { PluginRouteComponentProps } from "@t3tools/plugin-sdk-web";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import {
  parsePluginIdParam,
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

function normalizeSearch(search: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      normalized[key] = String(value);
    }
  }
  return normalized;
}

function PluginRouteView() {
  const params = Route.useParams();
  const search = Route.useSearch() as Record<string, unknown>;
  const snapshot = useAtomValue(pluginUiRegistryAtom);
  // Non-throwing parse: `$pluginId` is a raw user-typed URL segment, and an
  // invalid id must land on the not-found view, not crash the route tree.
  const pluginId = parsePluginIdParam(params.pluginId);
  const route =
    pluginId === null
      ? null
      : resolvePluginRouteRegistration(snapshot, pluginId, splatFromParams(params));

  if (!route) {
    return <PluginRouteNotFound />;
  }

  const surfaceLabel = `route:${route.pluginId}:${route.path}`;

  // Render the plugin component as its OWN React element (createElement), not
  // by calling it as a function: a function call would run the plugin's hooks
  // on this route's fiber and break the Rules of Hooks when the resolved
  // component changes. As an element it gets its own fiber and the error
  // boundary actually wraps the mounted component.
  //
  // Key the boundary by the surface: TanStack Router reuses this route
  // component across param-only changes, so without the key one plugin's crash
  // would leave the boundary stuck on the fallback for every other plugin
  // route. `resetKey` retries after a registry re-sync reloads the plugin.
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <PluginSurfaceErrorBoundary
        key={surfaceLabel}
        label={surfaceLabel}
        resetKey={route.component}
      >
        {createElement(route.component as FunctionComponent<PluginRouteComponentProps>, {
          pluginId: route.pluginId,
          path: route.path,
          environmentId: typeof params.environmentId === "string" ? params.environmentId : null,
          search: normalizeSearch(search),
        })}
      </PluginSurfaceErrorBoundary>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/p/$pluginId/$")({
  component: PluginRouteView,
});
