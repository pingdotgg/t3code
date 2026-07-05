import { createFileRoute } from "@tanstack/react-router";

import { AppPlaceholderView } from "../components/AppPlaceholderView";

export const Route = createFileRoute("/slack")({
  component: SlackRouteView,
});

function SlackRouteView() {
  return (
    <AppPlaceholderView title="Slack" description="Team conversation workflows will appear here." />
  );
}
