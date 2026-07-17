import { useAtomValue } from "@effect/atom-react";
import type { PluginId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { createElement, type FunctionComponent } from "react";
import type { PluginSettingsComponentProps } from "@t3tools/plugin-sdk-web";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import {
  parsePluginIdParam,
  PluginSurfaceErrorBoundary,
  pluginUiRegistryAtom,
  resolvePluginSettingsPageRegistration,
} from "../plugins/PluginUiHost";

function splatFromParams(params: Record<string, unknown>): string {
  const value = params._splat ?? params["*"];
  return typeof value === "string" ? value : "";
}

function parseSettingsSplat(splat: string): {
  readonly pluginId: PluginId;
  readonly pageId: string;
} | null {
  const parts = splat.split("/");
  const pluginIdIndex = parts.findIndex((part) => part.length > 0);
  if (pluginIdIndex < 0) {
    return null;
  }
  const rawPluginId = parts[pluginIdIndex];
  const pageId = parts
    .slice(pluginIdIndex + 1)
    .filter((part) => part.length > 0)
    .join("/");
  // Non-throwing parse: the splat is a raw user-typed URL, and an invalid
  // plugin id must land on the not-found view, not crash the route tree.
  const pluginId = rawPluginId === undefined ? null : parsePluginIdParam(rawPluginId);
  if (pluginId === null || pageId.length === 0) {
    return null;
  }
  return { pluginId, pageId };
}

function PluginSettingsNotFound() {
  return (
    <SettingsPageContainer>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Plugin settings not found</EmptyTitle>
          <EmptyDescription>The plugin settings page is not registered.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SettingsPageContainer>
  );
}

function PluginSettingsRouteView() {
  const params = Route.useParams();
  const parsed = parseSettingsSplat(splatFromParams(params));
  const snapshot = useAtomValue(pluginUiRegistryAtom);
  const page = parsed
    ? resolvePluginSettingsPageRegistration(snapshot, parsed.pluginId, parsed.pageId)
    : null;

  if (!page) {
    return <PluginSettingsNotFound />;
  }

  const surfaceLabel = `settings:${page.pluginId}:${page.id}`;

  // Render as an element (its own fiber) so plugin hooks work — see the note
  // in the plugin route splat. The boundary is keyed per surface (the router
  // reuses this component across param-only changes) and resets when a
  // registry re-sync reloads the plugin's component.
  return (
    <SettingsPageContainer>
      <PluginSurfaceErrorBoundary key={surfaceLabel} label={surfaceLabel} resetKey={page.component}>
        {createElement(page.component as FunctionComponent<PluginSettingsComponentProps>, {
          pluginId: page.pluginId,
          pageId: page.id,
        })}
      </PluginSurfaceErrorBoundary>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/$")({
  component: PluginSettingsRouteView,
});
