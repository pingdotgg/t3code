import { getRouteApi } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";

const routeApi = getRouteApi("/_chat/settings/providers");

/**
 * Providers are machine state, so the page shows one environment at a time:
 * the chosen one from the settings scope selector.
 * A project crumb narrows candidates to where that project is registered.
 */
export function SettingsProvidersRoute() {
  const target = routeApi.useSearch();
  const { environment, scope } = useSettingsScope();
  const gt = useGT();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? gt("Reconnect {label} to set up its providers.", { label: scope.label })
          : gt("Connect an environment to set up its providers.")}
      </p>
    );
  }
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      projectIds={
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members
              .filter((member) => member.environmentId === environment.environmentId)
              .map((member) => member.id)
          : []
      }
      scoped
    />
  );
}
