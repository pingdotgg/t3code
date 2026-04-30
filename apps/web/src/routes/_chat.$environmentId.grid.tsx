import { type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { GridView } from "../components/grid/GridView";

function GridRouteView() {
  const { environmentId } = Route.useParams();
  return <GridView environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/_chat/$environmentId/grid")({
  component: GridRouteView,
});
