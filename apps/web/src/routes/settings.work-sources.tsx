import { createFileRoute } from "@tanstack/react-router";

import { WorkSourceConnectionsSettings } from "../components/settings/WorkSourceConnectionsSettings";

export const Route = createFileRoute("/settings/work-sources")({
  component: WorkSourceConnectionsSettings,
});
