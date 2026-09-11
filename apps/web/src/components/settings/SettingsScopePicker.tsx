import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { ChevronDownIcon, ComputerIcon, FolderIcon, LayersIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { selectTriggerVariants } from "../ui/select";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { settingsScopeEnvironmentLabel } from "./SettingsScopePicker.logic";

interface ScopeOption {
  label: string;
  searchLabel: string;
  detail?: string | undefined;
  scope: SettingsScopeSearch;
  icon: ReactNode;
  indented?: boolean;
}

function optionKey(scope: SettingsScopeSearch): string {
  return JSON.stringify([scope.scope, scope.project, scope.machine, scope.checkout]);
}

export function SettingsScopePicker({
  value,
  groups,
  environments,
  onChange,
  includeDevice = false,
}: {
  value: SettingsScopeSearch;
  groups: readonly SidebarProjectSnapshot[];
  environments: readonly EnvironmentPresentation[];
  onChange: (next: SettingsScopeSearch) => void;
  includeDevice?: boolean;
}) {
  const [query, setQuery] = useState("");
  const resolved = resolveSettingsScope(value, groups, environments);
  const selectedEnvironment =
    resolved.kind === "environment" || resolved.kind === "checkout" || resolved.kind === "project"
      ? environments.find((environment) => environment.environmentId === resolved.environmentId)
      : undefined;
  const selectedEnvironmentLabel = selectedEnvironment
    ? settingsScopeEnvironmentLabel(selectedEnvironment, environments)
    : undefined;
  const triggerLabel =
    selectedEnvironmentLabel && resolved.kind === "checkout"
      ? `${resolved.group.displayName} / ${selectedEnvironmentLabel} · ${resolved.checkout.workspaceRoot}`
      : selectedEnvironmentLabel && resolved.kind === "project"
        ? `${resolved.group.displayName} / ${selectedEnvironmentLabel}`
        : (selectedEnvironmentLabel ?? resolved.label);
  const optionGroups = useMemo(() => {
    const environmentById = new Map<string, EnvironmentPresentation>(
      environments.map((environment) => [environment.environmentId, environment]),
    );
    const defaults: ScopeOption[] = [
      {
        label: "All environments",
        searchLabel: "All environments defaults",
        scope: { scope: "all" },
        icon: <LayersIcon aria-hidden className="size-3.5" />,
      },
    ];
    if (includeDevice) {
      defaults.push({
        label: "This device",
        searchLabel: "This device appearance preferences",
        scope: { scope: "device" },
        icon: <ComputerIcon aria-hidden className="size-3.5" />,
      });
    }
    return [
      { id: "defaults", label: "Settings for", items: defaults },
      {
        id: "environments",
        label: "Environments",
        items: environments.map((environment): ScopeOption => ({
          label: environment.label,
          searchLabel: `${environment.label} ${environment.displayUrl ?? environment.environmentId} environment defaults`,
          detail:
            [
              environments.some(
                (other) =>
                  other.environmentId !== environment.environmentId &&
                  other.label === environment.label,
              )
                ? (environment.displayUrl ?? environment.environmentId)
                : null,
              environment.connection.phase === "connected" ? null : "Offline",
            ]
              .filter(Boolean)
              .join(" · ") || undefined,
          scope: { machine: environment.environmentId },
          icon: (
            <EnvironmentMachineIcon
              aria-hidden
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              className="size-3.5"
            />
          ),
        })),
      },
      ...groups.map((group) => {
        const items: ScopeOption[] = [
          {
            label: "All checkouts",
            searchLabel: `${group.displayName} all checkouts`,
            detail: `${group.memberProjects.length} ${group.memberProjects.length === 1 ? "checkout" : "checkouts"}`,
            scope: { project: group.projectKey },
            icon: <ProjectFavicon project={group} className="size-3.5" />,
          },
        ];
        // Old links can select several checkouts on one environment. Keep that
        // exact aggregate selected until the user chooses a different target.
        if (value.project === group.projectKey && value.machine && !value.checkout) {
          const environment = environmentById.get(value.machine);
          if (
            environment &&
            group.memberProjects.some((member) => member.environmentId === value.machine)
          ) {
            items.push({
              label: `All checkouts on ${settingsScopeEnvironmentLabel(environment, environments)}`,
              searchLabel: `${group.displayName} all checkouts ${settingsScopeEnvironmentLabel(environment, environments)}`,
              scope: { project: group.projectKey, machine: environment.environmentId },
              icon: <FolderIcon aria-hidden className="size-3.5" />,
              indented: true,
            });
          }
        }
        for (const member of group.memberProjects) {
          const environment = environmentById.get(member.environmentId);
          const environmentLabel = environment
            ? settingsScopeEnvironmentLabel(environment, environments)
            : (member.environmentLabel ?? "Unavailable environment");
          items.push({
            label: environmentLabel,
            searchLabel: `${group.displayName} ${environmentLabel} ${member.workspaceRoot}`,
            detail: member.workspaceRoot,
            scope: {
              project: group.projectKey,
              machine: member.environmentId,
              checkout: member.physicalProjectKey,
            },
            icon: (
              <EnvironmentMachineIcon
                aria-hidden
                kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                className="size-3.5"
              />
            ),
            indented: true,
          });
        }
        return { id: `project:${group.projectKey}`, label: group.displayName, items };
      }),
    ].filter((group) => group.items.length > 0);
  }, [environments, groups, includeDevice, value.project, value.machine, value.checkout]);

  const normalizedValue: SettingsScopeSearch =
    resolved.kind === "all" || resolved.kind === "device"
      ? { scope: resolved.kind }
      : resolved.kind === "checkout"
        ? {
            project: resolved.group.projectKey,
            machine: resolved.environmentId,
            checkout: resolved.checkout.physicalProjectKey,
          }
        : value;
  const selected =
    resolved.kind === "unavailable"
      ? null
      : (optionGroups
          .flatMap((group) => group.items)
          .find((option) => optionKey(option.scope) === optionKey(normalizedValue)) ?? null);

  return (
    <Combobox
      items={optionGroups}
      value={selected}
      itemToStringLabel={(item: ScopeOption) => item.searchLabel}
      isItemEqualToValue={(item, selectedValue) =>
        optionKey(item.scope) === optionKey(selectedValue.scope)
      }
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={() => setQuery("")}
      onValueChange={(next) => {
        if (next) onChange(next.scope);
      }}
    >
      <ComboboxTrigger
        aria-label="Settings scope"
        title={triggerLabel}
        className={cn(selectTriggerVariants({ size: "compact" }), "w-auto min-w-0 max-w-full")}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selected?.icon}
          <span className="truncate">{triggerLabel}</span>
        </span>
        <ChevronDownIcon aria-hidden className="-me-1 size-3 shrink-0 opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-80">
        <ComboboxSearchInput
          aria-label="Search settings scopes"
          placeholder="Search environments or projects..."
        />
        <ComboboxEmpty>No matching environments or projects.</ComboboxEmpty>
        <ComboboxList>
          {(group: (typeof optionGroups)[number]) => (
            <ComboboxGroup key={group.id} items={group.items}>
              <ComboboxGroupLabel>{group.label}</ComboboxGroupLabel>
              <ComboboxCollection>
                {(item: ScopeOption) => (
                  <ComboboxItem
                    key={optionKey(item.scope)}
                    value={item}
                    title={item.searchLabel}
                    className={item.indented ? "ps-5" : undefined}
                    contentClassName="flex min-w-0 items-center gap-2"
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1">
                      <span className={item.indented ? "block break-words" : "block truncate"}>
                        {item.label}
                      </span>
                      {item.detail ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.detail}
                        </span>
                      ) : null}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
