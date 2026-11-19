import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { T, useGT } from "gt-react";
import { CheckIcon, FolderIcon, LayersIcon, RotateCcwIcon, SearchIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn, normalizeSearchText } from "~/lib/utils";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button, ContentButton } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { RESETTABLE_PROJECT_OVERRIDE_KEYS, summarizeProjectOverrides } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_CHECKOUTS_VALUE,
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectCheckoutAxis,
  selectEnvironmentAxis,
  selectProjectAxis,
  SETTINGS_DEVICE_ONLY_PATHS,
  settingsScopeCheckoutChoices,
  settingsScopeCheckoutLabel,
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
 * where a project override is written. Device-only pages keep their page label.
 */
export function SettingsScopePicker({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const scope = useOptionalSettingsScope();
  const { environments } = useEnvironments();
  if (
    scope === null ||
    SETTINGS_DEVICE_ONLY_PATHS.has(pathname) ||
    pathname === "/settings/open-source-licenses"
  )
    return children;
  return (
    <ScopePopover
      trigger={children}
      value={scope.search}
      groups={scope.groups}
      environments={environments}
      singleEnvironment={scope.singleEnvironment}
      onChange={scope.selectScope}
    />
  );
}

function ScopePopover({
  trigger,
  value,
  groups,
  environments,
  singleEnvironment,
  onChange,
}: {
  trigger: ReactNode;
  value: SettingsScopeSearch;
  groups: readonly SidebarProjectSnapshot[];
  environments: readonly EnvironmentPresentation[];
  /** Pages like Providers configure one environment, so "All environments" is not offered. */
  singleEnvironment: boolean;
  onChange: (next: SettingsScopeSearch) => void;
}) {
  const gt = useGT();
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
    selectedProject?.displayName ?? (value.project ? gt("Unavailable project") : null);
  const environmentLabel = selectedEnvironment
    ? settingsScopeEnvironmentLabel(selectedEnvironment, environments)
    : environmentValue !== ALL_ENVIRONMENTS_VALUE
      ? gt("Unavailable environment")
      : null;
  const triggerLabel =
    projectLabel && environmentLabel
      ? gt("{project} on {environment}", { project: projectLabel, environment: environmentLabel })
      : (projectLabel ??
        environmentLabel ??
        gt("All", { $context: "settings scope, every project and environment" }));
  const checkouts = selectedProject ? settingsScopeCheckoutChoices(selectedProject, value) : [];
  const selectedCheckout = checkouts.find((member) => member.physicalProjectKey === value.checkout);
  const checkoutLabel = selectedCheckout
    ? settingsScopeCheckoutLabel(selectedCheckout, checkouts)
    : value.checkout
      ? gt("Unavailable checkout")
      : null;

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
    machines: settingsScopeProjectMachines(group, environments, true)
      .flatMap(({ primary, secondary }) => [primary, secondary].filter(Boolean))
      .join(", "),
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
            ? `${machines}, ${group.workspaceRoot}`
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
    const question =
      environmentValue === ALL_ENVIRONMENTS_VALUE || environmentLabel === null
        ? gt(
            "{count, plural, one {Reset settings overrides for {count} project on every connected environment?} other {Reset settings overrides for {count} projects on every connected environment?}}",
            { count: overriddenProjectCount },
          )
        : gt(
            "{count, plural, one {Reset settings overrides for {count} project on {environment}?} other {Reset settings overrides for {count} projects on {environment}?}}",
            { count: overriddenProjectCount, environment: environmentLabel },
          );
    const confirmed =
      (await readLocalApi()?.dialogs.confirm(
        [
          question,
          gt("They will follow the environment settings again. Project actions are kept."),
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
        aria-label={
          checkoutLabel
            ? gt("Settings scope: {scope} in {checkout}", {
                scope: triggerLabel,
                checkout: checkoutLabel,
              })
            : gt("Settings scope: {scope}", { scope: triggerLabel })
        }
        render={<ContentButton variant="breadcrumb" className="-ms-2.5" />}
      >
        {trigger}
        {projectLabel || environmentLabel ? (
          <span className="min-w-0 truncate text-meta text-muted-foreground">
            {checkoutLabel
              ? gt("{scope} in {checkout}", { scope: triggerLabel, checkout: checkoutLabel })
              : triggerLabel}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" alignOffset={48} padding="none" initialFocus={searchRef}>
        <div
          className={cn(
            "flex max-w-[calc(100vw-2rem)] flex-col [-webkit-app-region:no-drag]",
            checkouts.length > 0 ? "w-[43rem]" : "w-[28.75rem]",
          )}
        >
          <div className="p-2">
            <InputGroup variant="ghost">
              <InputGroupAddon>
                <SearchIcon aria-hidden className="size-3.5" />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={gt("Find a project or environment")}
                aria-label={gt("Find a project or environment")}
              />
            </InputGroup>
          </div>
          <div className="flex min-h-0">
            <ScopeColumn label={gt("Project")}>
              <ScopeRow
                icon={<LayersIcon aria-hidden className="size-3.5" />}
                label={gt("All projects")}
                selected={projectValue === ALL_PROJECTS_VALUE}
                onSelect={() => choose(selectProjectAxis(value, ALL_PROJECTS_VALUE))}
              />
              {visibleGroups.map(({ group, secondary }) => (
                <ScopeRow
                  key={group.projectKey}
                  icon={<ProjectFavicon project={group} className="size-3.5" />}
                  label={group.displayName}
                  secondary={
                    group.archived
                      ? [secondary, gt("Archived", { $context: "project state" })]
                          .filter(Boolean)
                          .join(", ")
                      : secondary
                  }
                  meta={overrides.countByProjectKey.get(group.projectKey)}
                  metaLabel={gt("overridden settings", {
                    $context: "screen reader text after a count of settings",
                  })}
                  selected={projectValue === group.projectKey}
                  onSelect={() => choose(selectProjectAxis(value, group.projectKey))}
                />
              ))}
            </ScopeColumn>
            <div aria-hidden className="w-px shrink-0 bg-border" />
            <ScopeColumn label={gt("Environment")}>
              {singleEnvironment ? null : (
                <ScopeRow
                  icon={<LayersIcon aria-hidden className="size-3.5" />}
                  label={gt("All environments")}
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
                  meta={environment.connection.phase === "connected" ? undefined : gt("Offline")}
                  selected={environmentValue === environment.environmentId}
                  onSelect={() => choose(selectEnvironmentAxis(value, environment.environmentId))}
                />
              ))}
            </ScopeColumn>
            {checkouts.length > 0 ? (
              <>
                <div aria-hidden className="w-px shrink-0 bg-border" />
                <ScopeColumn label={gt("Checkout", { $context: "settings scope column" })}>
                  <ScopeRow
                    icon={<LayersIcon aria-hidden className="size-3.5" />}
                    label={gt("All checkouts")}
                    selected={(value.checkout ?? ALL_CHECKOUTS_VALUE) === ALL_CHECKOUTS_VALUE}
                    onSelect={() => choose(selectCheckoutAxis(value, null))}
                  />
                  {checkouts
                    .filter((member) => matches(member.workspaceRoot))
                    .map((member) => (
                      <ScopeRow
                        key={member.physicalProjectKey}
                        icon={<FolderIcon aria-hidden className="size-3.5" />}
                        label={fileBasename(member.workspaceRoot)}
                        secondary={member.workspaceRoot}
                        selected={value.checkout === member.physicalProjectKey}
                        onSelect={() => choose(selectCheckoutAxis(value, member))}
                      />
                    ))}
                </ScopeColumn>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-2 border-t border-border px-3.5 py-2">
            <p className="min-w-0 flex-1 truncate text-meta text-dim-foreground">
              {overriddenProjectCount === 0
                ? gt("No project overrides settings")
                : gt(
                    "{count, plural, one {{count} project overrides some settings} other {{count} projects override some settings}}",
                    { count: overriddenProjectCount },
                  )}
            </p>
            <Button
              size="xs"
              variant="secondary"
              disabled={overriddenProjectCount === 0}
              onClick={() => void resetOverrides()}
            >
              <RotateCcwIcon />
              <T>Reset overrides</T>
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
  return (
    <Button
      variant={selected ? "secondary" : "ghost-muted"}
      size="sm-multiline"
      aria-pressed={selected}
      onClick={onSelect}
      className="w-full justify-start"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-body">
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
      </span>
    </Button>
  );
}
