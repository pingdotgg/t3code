import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
} from "./SettingsScopeSelects.logic";

const TRIGGER_CLASSNAME = "w-auto min-w-0 max-w-56 justify-start";

/**
 * Two independent targets: which environments a change applies to, and
 * which project it overrides. A project is the same project on every
 * environment; the environment select alone decides where the override is
 * written. Each axis defaults to "all".
 */
export function SettingsScopeSelects({
  value,
  groups,
  environments,
  onChange,
}: {
  value: SettingsScopeSearch;
  groups: readonly SidebarProjectSnapshot[];
  environments: readonly EnvironmentPresentation[];
  onChange: (next: SettingsScopeSearch) => void;
}) {
  const resolved = resolveSettingsScope(value, groups, environments);
  const environmentValue = environmentAxisValue(value);
  const projectValue = projectAxisValue(value);
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === value.machine,
  );
  const selectedGroup = groups.find((group) => group.projectKey === value.project);

  return (
    <div className="flex min-w-0 items-center gap-1.5" role="group" aria-label="Settings scope">
      <Select
        value={environmentValue}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(selectEnvironmentAxis(value, next));
        }}
      >
        <SelectTrigger size="compact" aria-label="Environment scope" className={TRIGGER_CLASSNAME}>
          <SelectValue>
            <span className="flex min-w-0 items-center gap-1.5">
              {selectedEnvironment ? (
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={resolveEnvironmentMachineKind(selectedEnvironment.serverConfig)}
                  className="size-3.5"
                />
              ) : (
                <LayersIcon aria-hidden className="size-3.5" />
              )}
              <span className="truncate">
                {selectedEnvironment
                  ? settingsScopeEnvironmentLabel(selectedEnvironment, environments)
                  : value.machine
                    ? "Unavailable environment"
                    : "All environments"}
              </span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-56">
          <SelectItem value={ALL_ENVIRONMENTS_VALUE}>
            <span className="flex items-center gap-2">
              <LayersIcon aria-hidden className="size-3.5" />
              All environments
            </span>
          </SelectItem>
          <SelectGroup>
            <SelectGroupLabel>Environments</SelectGroupLabel>
            {environments.map((environment) => (
              <SelectItem key={environment.environmentId} value={environment.environmentId}>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                    className="size-3.5"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {settingsScopeEnvironmentLabel(environment, environments)}
                  </span>
                  {environment.connection.phase === "connected" ? null : (
                    <span className="text-xs text-muted-foreground">Offline</span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>

      <Select
        value={projectValue}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(selectProjectAxis(value, next));
        }}
      >
        <SelectTrigger size="compact" aria-label="Project scope" className={TRIGGER_CLASSNAME}>
          <SelectValue>
            <span className="flex min-w-0 items-center gap-1.5">
              {selectedGroup ? (
                <ProjectFavicon project={selectedGroup} className="size-3.5" />
              ) : null}
              <span className="truncate">
                {selectedGroup?.displayName ??
                  (value.project ? "Unavailable project" : "All projects")}
              </span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-56">
          <SelectItem value={ALL_PROJECTS_VALUE}>All projects</SelectItem>
          {groups.map((group) => (
            <SelectItem key={group.projectKey} value={group.projectKey}>
              <span className="flex w-full min-w-0 items-center gap-2">
                <ProjectFavicon project={group} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {resolved.kind === "unavailable" ? (
        <span className="truncate text-xs text-muted-foreground">{resolved.message}</span>
      ) : null}
    </div>
  );
}
