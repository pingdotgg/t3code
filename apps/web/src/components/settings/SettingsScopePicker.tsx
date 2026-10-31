import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  LaptopIcon,
  LayersIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn, normalizeSearchText } from "~/lib/utils";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { RESETTABLE_PROJECT_OVERRIDE_KEYS, summarizeProjectOverrides } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectEnvironmentAxis,
  selectProjectAxis,
  SETTINGS_DEVICE_ONLY_PATHS,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";
import { useClearProjectOverridesOn } from "./useScopedSettings";

/**
 * The scope segment of the settings tab (pen EV7oi, bwjGD): the project and
 * environment a change is written to, picked from one popover. A project is
 * the same project on every environment, so the environment alone decides
 * where a project override is written. Device-only pages read "This device".
 */
export function SettingsScopePicker({ pathname }: { pathname: string }) {
  const scope = useOptionalSettingsScope();
  const { environments } = useEnvironments();
  if (scope === null) return null;
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.75 text-strong-foreground">
        <LaptopIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">This device</span>
      </span>
    );
  }
  return (
    <ScopePopover
      value={scope.search}
      groups={scope.groups}
      environments={environments}
      singleEnvironment={scope.singleEnvironment}
      onChange={scope.selectScope}
    />
  );
}

function ScopePopover({
  value,
  groups,
  environments,
  singleEnvironment,
  onChange,
}: {
  value: SettingsScopeSearch;
  groups: readonly SidebarProjectSnapshot[];
  environments: readonly EnvironmentPresentation[];
  /** Pages like Providers configure one environment, so "All environments" is not offered. */
  singleEnvironment: boolean;
  onChange: (next: SettingsScopeSearch) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const resolved = resolveSettingsScope(value, groups, environments);
  const projectValue = projectAxisValue(value);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selectedProject = groups.find((group) => group.projectKey === value.project);
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  const projectLabel =
    selectedProject?.displayName ?? (value.project ? "Unavailable project" : null);
  const environmentLabel = selectedEnvironment
    ? settingsScopeEnvironmentLabel(selectedEnvironment, environments)
    : environmentValue !== ALL_ENVIRONMENTS_VALUE
      ? "Unavailable environment"
      : null;
  const triggerLabel =
    projectLabel && environmentLabel
      ? `${projectLabel} · ${environmentLabel}`
      : (projectLabel ?? environmentLabel ?? "All");
  const triggerIcon = selectedProject ? (
    <ProjectFavicon project={selectedProject} className="size-3.5 shrink-0" />
  ) : selectedEnvironment ? (
    <EnvironmentMachineIcon
      aria-hidden
      kind={resolveEnvironmentMachineKind(selectedEnvironment.serverConfig)}
      className="size-3.5 shrink-0"
    />
  ) : (
    <LayersIcon aria-hidden className="size-3.5 shrink-0" />
  );

  const clearOverrides = useClearProjectOverridesOn();
  // Overrides on the environments the selection covers: one, or every connected one.
  const overrideEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      (environmentValue === ALL_ENVIRONMENTS_VALUE ||
        environment.environmentId === environmentValue),
  );
  const overrides = summarizeProjectOverrides(groups, overrideEnvironments);
  const overriddenProjectCount = overrides.countByProjectKey.size;

  const normalizedQuery = normalizeSearchText(query);
  const matches = (label: string) =>
    normalizedQuery.length === 0 || normalizeSearchText(label).includes(normalizedQuery);
  const projects = projectScopeMenuGroups(groups, value).map((group) => ({
    group,
    machines: settingsScopeProjectMachines(group, environments, true).join(", "),
  }));
  const visibleGroups = projects
    .map(({ group, machines }) => {
      const sameName = projects.filter(
        (other) =>
          other.group.projectKey !== group.projectKey &&
          other.group.displayName === group.displayName,
      );
      const secondary =
        sameName.length === 0
          ? environments.length > 1
            ? group.workspaceRoot
            : ""
          : sameName.some((other) => other.machines === machines)
            ? `${machines} · ${group.workspaceRoot}`
            : machines;
      return { group, secondary };
    })
    .filter(({ group, secondary }) =>
      matches(`${group.displayName} ${secondary} ${group.projectKey}`),
    );
  const memberEnvironmentIds = selectedProject
    ? new Set(selectedProject.memberProjects.map((member) => member.environmentId))
    : null;
  const visibleEnvironments = environments
    .filter(
      (environment) =>
        memberEnvironmentIds === null || memberEnvironmentIds.has(environment.environmentId),
    )
    .map((environment) => {
      const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
      return {
        environment,
        label: primary,
        secondary:
          environments.length <= 1 ? "" : secondary || settingsScopeEnvironmentAddress(environment),
      };
    })
    .filter(({ environment, label, secondary }) =>
      matches(`${label} ${secondary} ${environment.environmentId}`),
    );

  const choose = (next: SettingsScopeSearch) => {
    setOpen(false);
    onChange(next);
  };
  const resetOverrides = async () => {
    const environmentNames =
      environmentValue === ALL_ENVIRONMENTS_VALUE
        ? "every connected environment"
        : (environmentLabel ?? "this environment");
    const confirmed =
      (await readLocalApi()?.dialogs.confirm(
        [
          `Reset settings overrides for ${overriddenProjectCount} ${overriddenProjectCount === 1 ? "project" : "projects"} on ${environmentNames}?`,
          "They will follow the environment settings again. Project actions are kept.",
        ].join("\n"),
        { variant: "destructive" },
      )) ?? false;
    if (!confirmed) return;
    clearOverrides(overrideEnvironments, overrides.entries, RESETTABLE_PROJECT_OVERRIDE_KEYS);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        aria-label={`Settings scope: ${triggerLabel}`}
        render={
          <button
            type="button"
            className="inline-flex min-w-0 cursor-pointer items-center gap-1.75 rounded-sm text-strong-foreground outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-ring"
          />
        }
      >
        {triggerIcon}
        <span className="min-w-0 max-w-72 truncate">{triggerLabel}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-dim-foreground" />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="none" initialFocus={searchRef}>
        {/* no-drag: the popup overlaps the header's window drag region. */}
        <div className="flex w-[28.75rem] max-w-[calc(100vw-2rem)] flex-col [-webkit-app-region:no-drag]">
          <label className="flex h-10 items-center gap-2 border-b border-border px-3.5 text-muted-foreground">
            <SearchIcon aria-hidden className="size-3.5 shrink-0 text-dim-foreground" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Find a project or environment"
              aria-label="Find a project or environment"
              className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-placeholder"
            />
          </label>
          <div className="flex min-h-0">
            <ScopeColumn label="Project">
              <ScopeRow
                icon={<LayersIcon aria-hidden className="size-3.5" />}
                label="All projects"
                selected={projectValue === ALL_PROJECTS_VALUE}
                onSelect={() => choose(selectProjectAxis(value, ALL_PROJECTS_VALUE))}
              />
              {visibleGroups.map(({ group, secondary }) => (
                <ScopeRow
                  key={group.projectKey}
                  icon={<ProjectFavicon project={group} className="size-3.5" />}
                  label={group.displayName}
                  secondary={secondary}
                  meta={overrides.countByProjectKey.get(group.projectKey)}
                  metaLabel="overridden settings"
                  selected={projectValue === group.projectKey}
                  onSelect={() => choose(selectProjectAxis(value, group.projectKey))}
                />
              ))}
            </ScopeColumn>
            <div aria-hidden className="w-px shrink-0 bg-border" />
            <ScopeColumn label="Environment">
              {singleEnvironment ? null : (
                <ScopeRow
                  icon={<LayersIcon aria-hidden className="size-3.5" />}
                  label="All environments"
                  selected={environmentValue === ALL_ENVIRONMENTS_VALUE}
                  onSelect={() => choose(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
                />
              )}
              {visibleEnvironments.map(({ environment, label, secondary }) => (
                <ScopeRow
                  key={environment.environmentId}
                  icon={
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                      className="size-3.5"
                    />
                  }
                  label={label}
                  secondary={secondary}
                  meta={environment.connection.phase === "connected" ? undefined : "Offline"}
                  selected={environmentValue === environment.environmentId}
                  onSelect={() => choose(selectEnvironmentAxis(value, environment.environmentId))}
                />
              ))}
            </ScopeColumn>
          </div>
          <div className="flex items-center gap-2 border-t border-border px-3.5 py-2">
            <p className="min-w-0 flex-1 truncate text-meta text-dim-foreground">
              {overriddenProjectCount === 0
                ? "No project overrides settings"
                : `${overriddenProjectCount} ${overriddenProjectCount === 1 ? "project overrides" : "projects override"} some settings`}
            </p>
            <Button
              size="xs"
              variant="secondary"
              disabled={overriddenProjectCount === 0}
              onClick={() => void resetOverrides()}
            >
              <RotateCcwIcon />
              Reset overrides
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ScopeColumn({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-1 basis-0 flex-col gap-0.5 p-1.5"
    >
      <p className="px-2 py-1 text-meta text-dim-foreground">{label}</p>
      <div className="flex max-h-[min(24rem,calc(100dvh-14rem))] flex-col gap-0.5 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function ScopeRow({
  icon,
  label,
  secondary,
  meta,
  metaLabel,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  secondary?: string;
  meta?: number | string | undefined;
  metaLabel?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  // Every row carries the selected row's 1px border, so selecting one never shifts
  // its content; 1px + 7px puts icons on the column label and search glyph line.
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        selected
          ? "flex min-w-0 cursor-pointer items-center gap-2 rounded-item px-1.75 text-body text-foreground outline-none surface-raised focus-visible:inset-ring-2 focus-visible:inset-ring-ring"
          : "flex min-w-0 cursor-pointer items-center gap-2 rounded-item border border-transparent px-1.75 text-body text-muted-foreground outline-none hover:surface-ghost-hover hover:text-foreground focus-visible:inset-ring-2 focus-visible:inset-ring-ring",
        secondary ? "min-h-7.5 py-1.5" : "h-7.5 shrink-0",
      )}
    >
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{label}</span>
        {secondary ? (
          <span className="block truncate text-meta text-dim-foreground">{secondary}</span>
        ) : null}
      </span>
      {meta === undefined ? null : (
        <span className="shrink-0 text-meta text-dim-foreground">
          {meta}
          {metaLabel ? <span className="sr-only"> {metaLabel}</span> : null}
        </span>
      )}
      {selected ? <CheckIcon aria-hidden className="size-3 shrink-0" /> : null}
    </button>
  );
}
