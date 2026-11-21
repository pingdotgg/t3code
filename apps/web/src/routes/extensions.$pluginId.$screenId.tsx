import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { useLocation, createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { PluginRouteSurface } from "~/plugins/contributions";
import { EnvironmentPluginHost } from "~/plugins/PluginHost";
import { definePluginFeature } from "~/plugins/features";
import type { ReactElement } from "react";
import { T } from "gt-react";

function ExtensionScreen(): ReactElement {
  const { pluginId, screenId } = Route.useParams();
  const search = Route.useSearch();
  const primary = usePrimaryEnvironmentId();
  const path = useLocation({ select: (location) => location.pathname });
  const environmentId = search.machine ? EnvironmentId.make(search.machine) : primary;
  return environmentId ? (
    <EnvironmentPluginHost environmentId={environmentId}>
      <PluginRouteSurface
        environmentId={environmentId}
        pluginId={pluginId}
        routeId={screenId}
        path={path}
        search={search}
      />
    </EnvironmentPluginHost>
  ) : (
    <p className="p-6">
      <T>Connect an environment to open this extension.</T>
    </p>
  );
}

export const Route = createFileRoute("/extensions/$pluginId/$screenId")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...search,
    machine: typeof search.machine === "string" ? search.machine : undefined,
  }),
  component: definePluginRouteRenderer(
    "/extensions/$pluginId/$screenId",
    "component",
    definePluginFeature("extensions.route", ExtensionScreen),
  ),
});

registerBuiltinRoute("/extensions/$pluginId/$screenId", Route);
