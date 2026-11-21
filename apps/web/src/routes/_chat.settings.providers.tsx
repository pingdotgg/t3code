import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { SettingsProvidersRoute } from "../components/settings/SettingsProvidersPage";

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: definePluginRouteRenderer(
    "/settings/providers",
    "component",
    definePluginFeature("settings.providers", SettingsProvidersRoute),
  ),
});

registerBuiltinRoute("/settings/providers", Route);
