import { createFileRoute } from "@tanstack/react-router";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";

import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { useLayoutPageLocation } from "../layout/pageNavigation";

function SettingsScheduledTasksRoute() {
  const target = validateScheduledTasksSearch(useLayoutPageLocation().search);
  return <ScheduledTasksSettings {...target} />;
}

export const Route = createFileRoute("/_chat/settings/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: SettingsScheduledTasksRoute,
});
