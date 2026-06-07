import { createFileRoute } from "@tanstack/react-router";

import { RunsView } from "../components/RunsView";

export const Route = createFileRoute("/_chat/runs")({
  component: RunsView,
});
