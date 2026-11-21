import { createFileRoute, Navigate } from "@tanstack/react-router";

import { SecretsSettingsPanel } from "../components/settings/SecretsSettings";
import { useHasSecretProvidersEnvironment } from "../components/settings/useAvailableSettingsSearchItems";
import { useEnvironments } from "../state/environments";

export const Route = createFileRoute("/_chat/settings/secrets")({
  component: SecretsSettingsRoute,
});

function SecretsSettingsRoute() {
  const enabled = useHasSecretProvidersEnvironment();
  // Wait for a server config so a cold load does not bounce before any environment reports flags.
  const anyConfig = useEnvironments().environments.some(
    (environment) => environment.serverConfig !== null,
  );
  if (!enabled && anyConfig) return <Navigate to="/settings/general" replace />;
  return <SecretsSettingsPanel />;
}
