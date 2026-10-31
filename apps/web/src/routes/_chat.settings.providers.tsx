import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { useLayoutPageLocation } from "../layout/pageNavigation";

function SettingsProvidersRoute() {
  const { search } = useLayoutPageLocation();
  const instanceId =
    typeof search.instanceId === "string" && search.instanceId.trim()
      ? ProviderInstanceId.make(search.instanceId)
      : undefined;
  const { environment, scope } = useSettingsScope();
  const { resumeEnvironmentId } = Route.useSearch();
  if (!environment) {
    return (
      <p className="p-8 text-body text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its providers.`
          : "Connect an environment to set up its providers."}
      </p>
    );
  }
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      {...(instanceId ? { instanceId } : {})}
      projectIds={
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members
              .filter((member) => member.environmentId === environment.environmentId)
              .map((member) => member.id)
          : []
      }
      scoped
      {...(resumeEnvironmentId ? { resumeEnvironmentId } : {})}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
    ...(typeof raw.resumeEnvironmentId === "string" && raw.resumeEnvironmentId.trim()
      ? { resumeEnvironmentId: EnvironmentId.make(raw.resumeEnvironmentId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
