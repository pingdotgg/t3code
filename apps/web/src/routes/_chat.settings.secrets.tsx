import { createFileRoute, redirect } from "@tanstack/react-router";

import { SecretsSettingsPanel } from "../components/settings/SecretsSettings";
import { isSecretsFeatureEnabled } from "../env";

export const Route = createFileRoute("/_chat/settings/secrets")({
  beforeLoad: () => {
    if (!isSecretsFeatureEnabled) throw redirect({ to: "/settings/general", replace: true });
  },
  component: SecretsSettingsPanel,
});
