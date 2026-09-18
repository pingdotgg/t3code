import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";

import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { usePrimaryEnvironmentId } from "../state/environments";

function SettingsScheduledTasksRoute() {
  const target = Route.useSearch();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selectedEnvironmentId =
    target.environmentId ??
    (target.machine ? EnvironmentId.make(target.machine) : primaryEnvironmentId);
  return (
    <ScheduledTasksSettings
      {...target}
      {...(selectedEnvironmentId ? { environmentId: selectedEnvironmentId } : {})}
    />
  );
}

export const Route = createFileRoute("/settings/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: SettingsScheduledTasksRoute,
});
