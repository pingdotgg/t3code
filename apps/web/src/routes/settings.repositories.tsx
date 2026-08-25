import { createFileRoute } from "@tanstack/react-router";

import { RepositoriesSettingsPanel } from "../components/settings/RepositoriesSettings";

function SettingsRepositoriesRoute() {
  return <RepositoriesSettingsPanel />;
}

export const Route = createFileRoute("/settings/repositories")({
  component: SettingsRepositoriesRoute,
});
