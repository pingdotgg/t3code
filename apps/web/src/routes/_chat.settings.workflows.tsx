import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsSettings } from "../components/settings/WorkflowsSettings";

export const Route = createFileRoute("/_chat/settings/workflows")({
  component: WorkflowsSettings,
});
