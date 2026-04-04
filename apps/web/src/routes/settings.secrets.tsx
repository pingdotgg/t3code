import { createFileRoute } from "@tanstack/react-router";

import { VaultSettingsPanel } from "../components/settings/VaultSettingsPanel";

export const Route = createFileRoute("/settings/secrets")({
  component: VaultSettingsPanel,
});
