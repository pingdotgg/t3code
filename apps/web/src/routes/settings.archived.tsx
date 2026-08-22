import { createFileRoute } from "@tanstack/react-router";

import { validateArchivedThreadsSearch } from "../archiveProjectFiltering";
import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/archived")({
  validateSearch: validateArchivedThreadsSearch,
  component: ArchivedThreadsRouteView,
});

function ArchivedThreadsRouteView() {
  const search = Route.useSearch();
  return <ArchivedThreadsPanel projectKey={search.project ?? null} />;
}
