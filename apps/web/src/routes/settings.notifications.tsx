import { createFileRoute } from "@tanstack/react-router";

import { NotificationsSettingsPanel } from "../components/settings/NotificationsSettingsPanel";

function SettingsNotificationsRoute() {
  return <NotificationsSettingsPanel />;
}

export const Route = createFileRoute("/settings/notifications")({
  component: SettingsNotificationsRoute,
});
