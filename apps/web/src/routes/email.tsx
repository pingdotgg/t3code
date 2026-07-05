import { createFileRoute } from "@tanstack/react-router";

import { AppPlaceholderView } from "../components/AppPlaceholderView";

export const Route = createFileRoute("/email")({
  component: EmailRouteView,
});

function EmailRouteView() {
  return <AppPlaceholderView title="Email" description="Email workflows will appear here." />;
}
