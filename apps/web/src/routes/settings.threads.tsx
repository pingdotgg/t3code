import { createFileRoute } from "@tanstack/react-router";

import { ThreadsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/threads")({
  component: ThreadsSettingsPanel,
});
