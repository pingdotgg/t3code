import { createFileRoute, Navigate } from "@tanstack/react-router";

import { SecretsSettingsPanel } from "../components/settings/SecretsSettings";
import { useHasSecretProvidersEnvironment } from "../components/settings/useAvailableSettingsSearchItems";
import { useEnvironments } from "../state/environments";

export const Route = createFileRoute("/_chat/settings/secrets")({
  component: SecretsSettingsRoute,
});

function SecretsSettingsRoute() {
  const enabled = useHasSecretProvidersEnvironment();
  // Only redirect once every environment reported flags; one may enable them after another loads.
  const { isReady, environments } = useEnvironments();
  const allReported =
    isReady && environments.every((environment) => environment.serverConfig !== null);
  if (!enabled && allReported) return <Navigate to="/settings/general" replace />;
  return <SecretsSettingsPanel />;
}
