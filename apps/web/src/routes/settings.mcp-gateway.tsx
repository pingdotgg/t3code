import { createFileRoute } from "@tanstack/react-router";

import { McpGatewaySettings } from "../components/settings/McpGatewaySettings";

export const Route = createFileRoute("/settings/mcp-gateway")({
  component: McpGatewaySettings,
});
