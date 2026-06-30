import { createFileRoute } from "@tanstack/react-router";

import { OutboundConnectionsSettings } from "../components/settings/OutboundConnectionsSettings";

export const Route = createFileRoute("/settings/outbound")({
  component: OutboundConnectionsSettings,
});
