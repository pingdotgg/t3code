import { T, Var, useGT } from "gt-react";
import { createFileRoute } from "@tanstack/react-router";

import { InferenceSettings } from "../components/settings/InferenceSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsInferenceRoute() {
  const gt = useGT();
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? gt("Reconnect {environment} to manage inference accounts.", {
              environment: scope.label,
            })
          : gt("Connect an environment to manage inference accounts.")}
      </p>
    );
  }
  if (environment.serverConfig?.environment.capabilities.inferenceProxy)
    return (
      <InferenceSettings
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    );
  return (
    <p className="p-8 text-sm text-muted-foreground">
      <T>
        Update T3 Code on <Var>{environment.label}</Var> to manage inference accounts.
      </T>
    </p>
  );
}

export const Route = createFileRoute("/_chat/settings/inference")({
  component: SettingsInferenceRoute,
});
