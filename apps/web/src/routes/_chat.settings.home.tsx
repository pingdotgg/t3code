import { createFileRoute } from "@tanstack/react-router";

import { HomeSettingsPanel } from "../components/settings/HomeSettingsPanel";

export const Route = createFileRoute("/_chat/settings/home")({
  component: HomeSettingsPanel,
});
