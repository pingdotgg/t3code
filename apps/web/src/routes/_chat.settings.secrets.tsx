import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { SecretsSettingsPanel } from "../components/settings/SecretsSettings";
import { isSecretsFeatureEnabled } from "../env";

export const Route = createFileRoute("/_chat/settings/secrets")({
  beforeLoad: () => {
    if (!isSecretsFeatureEnabled) throw redirect({ to: "/settings/general", replace: true });
  },
  component: definePluginRouteRenderer(
    "/settings/secrets",
    "component",
    definePluginFeature("settings.secrets", SecretsSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/secrets", Route);
