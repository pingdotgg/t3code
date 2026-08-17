import { createFileRoute } from "@tanstack/react-router";

import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";

export const Route = createFileRoute("/settings/scheduled-tasks")({
  component: ScheduledTasksSettings,
});
