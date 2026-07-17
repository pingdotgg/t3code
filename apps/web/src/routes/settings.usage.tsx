import { createFileRoute } from "@tanstack/react-router";

import { ProviderUsageSettings } from "../components/settings/ProviderUsageSettings";

export const Route = createFileRoute("/settings/usage")({
  component: ProviderUsageSettings,
});
