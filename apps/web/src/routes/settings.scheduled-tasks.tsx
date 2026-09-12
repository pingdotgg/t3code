import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ScheduledTaskId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";

import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
} from "../components/ConnectionStatusDot";
import { ScrollArea } from "../components/ui/scroll-area";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

function SettingsScheduledTasksRoute() {
  const target = Route.useSearch();
  const navigate = Route.useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selectedEnvironmentId = target.environmentId ?? primaryEnvironmentId;
  const options = environments.toSorted((left, right) => {
    if (left.environmentId === primaryEnvironmentId) return -1;
    if (right.environmentId === primaryEnvironmentId) return 1;
    return left.label.localeCompare(right.label);
  });
  return (
    <ScheduledTasksSettings
      {...target}
      deviceTabs={
        options.length > 1 || target.environmentId ? (
          <ScrollArea hideScrollbars scrollFade className="h-11 min-w-0 rounded-none">
            <ToggleGroup
              aria-label="Devices"
              variant="segmented"
              className="my-2"
              value={selectedEnvironmentId ? [selectedEnvironmentId] : []}
              onValueChange={(next) => {
                const environment = options.find((option) => option.environmentId === next[0]);
                if (environment && environment.environmentId !== selectedEnvironmentId) {
                  void navigate({ search: { environmentId: environment.environmentId } });
                }
              }}
            >
              {options.map((environment) => (
                <Toggle
                  key={environment.environmentId}
                  value={environment.environmentId}
                  className="gap-2 text-left"
                  title={connectionStatusTitle(environment.connection)}
                >
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                    className="size-3.5 shrink-0"
                    aria-hidden
                  />
                  <span className="max-w-40 truncate">{environment.label}</span>
                  {environment.connection.phase !== "connected" ? (
                    <ConnectionStatusDot
                      dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                    />
                  ) : null}
                  <span className="sr-only">{connectionStatusTitle(environment.connection)}</span>
                </Toggle>
              ))}
            </ToggleGroup>
          </ScrollArea>
        ) : null
      }
    />
  );
}

export const Route = createFileRoute("/settings/scheduled-tasks")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  }),
  component: SettingsScheduledTasksRoute,
});
