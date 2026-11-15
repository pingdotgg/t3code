import { createFileRoute } from "@tanstack/react-router";

import { LocalModelsSettingsPanel } from "../components/settings/LocalModelsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/local-models")({
  component: LocalModelsSettingsPanel,
});
