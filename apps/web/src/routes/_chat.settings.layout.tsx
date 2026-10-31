import { createFileRoute } from "@tanstack/react-router";

import { LayoutSettings } from "../components/settings/LayoutSettings";

function SettingsLayoutRoute() {
  return <LayoutSettings />;
}

export const Route = createFileRoute("/_chat/settings/layout")({
  component: SettingsLayoutRoute,
});
