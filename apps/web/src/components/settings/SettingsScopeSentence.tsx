import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { CheckIcon, ChevronDownIcon, FolderIcon, LayersIcon, RotateCcwIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { readLocalApi } from "../../localApi";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { RESETTABLE_PROJECT_OVERRIDE_KEYS, summarizeProjectOverrides } from "./scopedSettings";
import { useClearProjectOverridesOn } from "./useScopedSettings";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  SETTINGS_DEVICE_ONLY_PATHS,
  ALL_CHECKOUTS_VALUE,
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectCheckoutAxis,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeCheckoutChoices,
  settingsScopeCheckoutLabel,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly singleEnvironment: boolean;
  readonly onChange: (next: SettingsScopeSearch) => void;
}

export function SettingsScopeSentence({ pathname }: { pathname: string }) {
  const scope = useOptionalSettingsScope();
  const { environments } = useEnvironments();
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  const props: SettingsScopeMenuProps = {
    value: scope.search,
    singleEnvironment: scope.singleEnvironment,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };
  const group = scope.groups.find((candidate) => candidate.projectKey === scope.search.project);
  const hasCheckouts = group ? settingsScopeCheckoutChoices(group, scope.search).length > 0 : false;
  const project = <ProjectScopeMenu {...props} />;
  const environment = <EnvironmentScopeMenu {...props} />;
  const checkout = <CheckoutScopeMenu {...props} />;
  const onEnvironment = scope.search.machine || scope.scope.kind === "checkout";
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-meta text-muted-foreground sm:px-4">
      {onEnvironment && hasCheckouts ? (
        <T context="settings scope sentence; each variable is a menu">
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">Applying settings for</span>
            <Var>{project}</Var>
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">on</span>
            <Var>{environment}</Var>
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">in</span>
            <Var>{checkout}</Var>
          </span>
        </T>
      ) : onEnvironment ? (
        <T context="settings scope sentence; each variable is a menu">
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">Applying settings for</span>
            <Var>{project}</Var>
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">on</span>
            <Var>{environment}</Var>
          </span>
        </T>
      ) : hasCheckouts ? (
        <T context="settings scope sentence; each variable is a menu">
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">Applying settings for</span>
            <Var>{project}</Var>
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">across</span>
            <Var>{environment}</Var>
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">in</span>
            <Var>{checkout}</Var>
          </span>
        </T>
      ) : (
        <T context="settings scope sentence; each variable is a menu">
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">Applying settings for</span>
            <Var>{project}</Var>
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 max-sm:flex-wrap">
            <span className="shrink-0">across</span>
            <Var>{environment}</Var>
          </span>
        </T>
      )}
    </p>
  );
}

interface ScopeOption {
  value: string;
  label: string;
  secondary?: string | readonly string[];
  archived?: boolean;
  icon?: ReactNode;
  offline?: boolean;
}

function ScopeOptionLabel({ option }: { option: ScopeOption }) {
  const gt = useGT();
  return (
    <>
      {option.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {option.secondary ? (
          <span className="flex min-w-0 flex-col text-meta text-muted-foreground">
            {(Array.isArray(option.secondary) ? option.secondary : [option.secondary]).map(
              (detail) => (
                <span key={detail} className="block truncate">
                  {detail}
                </span>
              ),
            )}
          </span>
        ) : null}
      </span>
      {option.archived ? (
        <span className="shrink-0 text-meta text-muted-foreground">
          {gt("Archived", { $context: "project state" })}
        </span>
      ) : null}
      {option.offline ? (
        <span className="shrink-0 text-meta text-dim-foreground">
          <T>Offline</T>
        </span>
      ) : null}
    </>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  value,
  options,
  allOption,
  searchLabel,
  onChange,
  footer,
  detail,
}: {
  footer?: ReactNode;
  detail?: string;
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  value: string;
  options: ScopeOption[];
  allOption: ScopeOption | null;
  searchLabel: string;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  const Trigger = options.length > 6 ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`${ariaLabel}: ${label}`}
      render={<Button variant="secondary" size="xs" />}
      className="min-w-0 max-w-72 shrink"
    >
      {icon}
      {detail ? (
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate" />}>{label}</TooltipTrigger>
          <TooltipPopup>
            <span className="block">{label}</span>
            <span className="block">{detail}</span>
          </TooltipPopup>
        </Tooltip>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
      />
    </Trigger>
  );
  const choices = allOption ? [allOption, ...options] : options;
  if (options.length > 6) {
    const needle = query.trim().toLowerCase();
    const filteredItems = choices.filter((option) =>
      `${option.label} ${option.secondary ?? ""} ${option.value}`.toLowerCase().includes(needle),
    );
    return (
      <Combobox
        items={choices}
        filteredItems={filteredItems}
        filter={null}
        autoHighlight
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        value={choices.find((option) => option.value === value) ?? null}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option) => {
          if (option) onChange(option.value);
        }}
      >
        {trigger}
        <ComboboxPopup align="start" className="w-80">
          <ComboboxSearchInput
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>
            <T>No matches found.</T>
          </ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option}>
                <ScopeOptionLabel option={option} />
                {option.value === value ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
          {footer}
        </ComboboxPopup>
      </Combobox>
    );
  }
  return (
    <Menu>
      {trigger}
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            {choices.map((option, index) => (
              <Fragment key={option.value}>
                <MenuRadioItem value={option.value} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <ScopeOptionLabel option={option} />
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
                {index === 0 && allOption ? <MenuSeparator /> : null}
              </Fragment>
            ))}
          </MenuRadioGroup>
          {footer}
        </div>
      </MenuPopup>
    </Menu>
  );
}

function CheckoutScopeMenu({ value, groups, onChange }: SettingsScopeMenuProps) {
  const gt = useGT();
  const group = groups.find((candidate) => candidate.projectKey === value.project);
  const checkouts = group ? settingsScopeCheckoutChoices(group, value) : [];
  if (checkouts.length === 0) return null;
  const selected = checkouts.find((member) => member.physicalProjectKey === value.checkout);
  return (
    <ScopeMenu
      ariaLabel={gt("Checkout scope")}
      icon={<FolderIcon aria-hidden className="size-3.5 shrink-0" />}
      label={
        selected
          ? settingsScopeCheckoutLabel(selected, checkouts)
          : value.checkout
            ? gt("Unavailable checkout")
            : gt("All checkouts")
      }
      value={value.checkout ?? ALL_CHECKOUTS_VALUE}
      onChange={(next) =>
        onChange(
          selectCheckoutAxis(
            value,
            checkouts.find((member) => member.physicalProjectKey === next) ?? null,
          ),
        )
      }
      searchLabel={gt("Search checkouts")}
      allOption={{ value: ALL_CHECKOUTS_VALUE, label: gt("All checkouts") }}
      options={checkouts.map((member) => ({
        value: member.physicalProjectKey,
        label: fileBasename(member.workspaceRoot),
        secondary: member.workspaceRoot,
      }))}
    />
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  singleEnvironment,
}: SettingsScopeMenuProps) {
  const messages = useMessages();
  const gt = useGT();
  const resolved = resolveSettingsScope(value, groups, environments, messages);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selected = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  const project = groups.find((group) => group.projectKey === value.project);
  const memberEnvironmentIds = project
    ? new Set(project.memberProjects.map((member) => member.environmentId))
    : null;
  const options = memberEnvironmentIds
    ? environments.filter((environment) => memberEnvironmentIds.has(environment.environmentId))
    : environments;
  return (
    <ScopeMenu
      ariaLabel={gt("Environment scope")}
      icon={
        selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={
        selected
          ? settingsScopeEnvironmentLabels(selected, environments).primary
          : environmentValue !== ALL_ENVIRONMENTS_VALUE
            ? gt("Unavailable environment")
            : singleEnvironment
              ? gt("No environments")
              : gt("All environments")
      }
      detail={selected ? settingsScopeEnvironmentLabels(selected, environments).secondary : ""}
      value={environmentValue}
      onChange={(next) => onChange(selectEnvironmentAxis(value, next))}
      searchLabel={gt("Search environments")}
      allOption={
        singleEnvironment
          ? null
          : {
              value: ALL_ENVIRONMENTS_VALUE,
              label: gt("All environments"),
              icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
            }
      }
      options={options.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return {
          value: environment.environmentId,
          label: primary,
          secondary:
            environments.length <= 1
              ? ""
              : secondary || settingsScopeEnvironmentAddress(environment),
          icon: (
            <EnvironmentMachineIcon
              aria-hidden
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              className="size-3.5 shrink-0"
            />
          ),
          offline: environment.connection.phase !== "connected",
        };
      })}
    />
  );
}

function ProjectScopeMenu({ value, groups, environments, onChange }: SettingsScopeMenuProps) {
  const gt = useGT();
  const selected = groups.find((group) => group.projectKey === value.project);
  const projects = projectScopeMenuGroups(groups, value).map((group) => ({
    group,
    machines: settingsScopeProjectMachines(group, environments, true).flatMap(
      ({ primary, secondary }) => [primary, secondary].filter(Boolean),
    ),
  }));
  return (
    <ScopeMenu
      ariaLabel={gt("Project scope")}
      icon={selected ? <ProjectFavicon project={selected} className="size-3.5 shrink-0" /> : null}
      label={
        selected?.displayName ?? (value.project ? gt("Unavailable project") : gt("All projects"))
      }
      value={projectAxisValue(value)}
      onChange={(next) => onChange(selectProjectAxis(value, next))}
      searchLabel={gt("Search projects")}
      footer={<ProjectScopeReset value={value} groups={groups} environments={environments} />}
      allOption={{ value: ALL_PROJECTS_VALUE, label: gt("All projects") }}
      options={projects.map(({ group, machines }) => {
        const sameName = projects.filter(
          (other) =>
            other.group.projectKey !== group.projectKey &&
            other.group.displayName === group.displayName,
        );
        const location =
          sameName.length === 0
            ? environments.length > 1
              ? [group.workspaceRoot]
              : []
            : sameName.some((other) => JSON.stringify(other.machines) === JSON.stringify(machines))
              ? [group.workspaceRoot, ...machines]
              : machines;
        return {
          value: group.projectKey,
          label: group.displayName,
          secondary: location,
          archived: group.archived,
          icon: <ProjectFavicon project={group} className="size-3.5 shrink-0" />,
        };
      })}
    />
  );
}

/** Keep the override reset from the former header picker in the project scope menu. */
function ProjectScopeReset({
  value,
  groups,
  environments,
}: Pick<SettingsScopeMenuProps, "value" | "groups" | "environments">) {
  const messages = useMessages();
  const gt = useGT();
  const resolved = resolveSettingsScope(value, groups, environments, messages);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === environmentValue,
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

  const resetOverrides = async () => {
    const question =
      environmentValue === ALL_ENVIRONMENTS_VALUE || !selectedEnvironment
        ? gt(
            "{count, plural, one {Reset settings overrides for {count} project on every connected environment?} other {Reset settings overrides for {count} projects on every connected environment?}}",
            { count: overriddenProjectCount },
          )
        : gt(
            "{count, plural, one {Reset settings overrides for {count} project on {environment}?} other {Reset settings overrides for {count} projects on {environment}?}}",
            {
              count: overriddenProjectCount,
              environment: settingsScopeEnvironmentLabels(selectedEnvironment, environments)
                .primary,
            },
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
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2">
      <p className="min-w-0 flex-1 text-meta text-dim-foreground">
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
  );
}
