import { createFileRoute } from "@tanstack/react-router";
import { MaintenanceSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/maintenance")({
  component: MaintenanceSettingsPanel,
});
