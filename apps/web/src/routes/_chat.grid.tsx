import { createFileRoute } from "@tanstack/react-router";

import { SessionGridView } from "../components/sessionGrid/SessionGridView";
import { parseSessionGridSearch } from "../components/sessionGrid/sessionGrid.logic";

function SessionGridRouteView() {
  const search = Route.useSearch();
  return <SessionGridView requestedProjectKey={search.project ?? null} />;
}

// fork: project session grid — a static workspace route keeps the shared
// sidebar mounted without colliding with canonical environment/thread URLs.
export const Route = createFileRoute("/_chat/grid")({
  validateSearch: parseSessionGridSearch,
  component: SessionGridRouteView,
});
