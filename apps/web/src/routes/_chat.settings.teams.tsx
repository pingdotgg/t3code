import { createFileRoute } from "@tanstack/react-router";

import { TeamsSettings } from "../components/team/TeamsSettings";

function SettingsTeamsRoute() {
  return <TeamsSettings />;
}

export const Route = createFileRoute("/_chat/settings/teams")({
  component: SettingsTeamsRoute,
});
