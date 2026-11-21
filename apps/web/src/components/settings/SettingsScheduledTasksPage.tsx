import { getRouteApi } from "@tanstack/react-router";

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const routeApi = getRouteApi("/_chat/settings/scheduled-tasks");

export function SettingsScheduledTasksRoute() {
  const target = routeApi.useSearch();
  return <ScheduledTasksSettings {...target} />;
}
