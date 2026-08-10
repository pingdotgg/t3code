import { createFileRoute } from "@tanstack/react-router";

import { McpServersSettings } from "../components/settings/McpServersSettings";

export const Route = createFileRoute("/settings/mcp")({
  component: McpServersSettings,
});
