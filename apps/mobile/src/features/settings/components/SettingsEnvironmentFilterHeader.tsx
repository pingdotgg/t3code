import { useGT } from "gt-react-native";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";

import type { AppBarMenu } from "../../../components/ui/AppBar.types";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../../components/EnvironmentMachineSymbol";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";

/** The settings scope filter, as an `AppBar` menu. */
export function useSettingsEnvironmentMenu(): AppBarMenu {
  const gt = useGT();
  const {
    availableTargets,
    selectedTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  return {
    title: gt("Filter settings environments and projects"),
    icon:
      selectedIds === null && selectedProjectKey === null
        ? "line.3.horizontal.decrease"
        : "line.3.horizontal.decrease.circle.fill",
    items: [
      {
        id: "environments",
        title:
          selectedIds === null
            ? gt("All environments")
            : gt("{count, plural, one {{count} environment} other {{count} environments}}", {
                count: selectedTargets.length,
              }),
        items: [
          {
            id: "all",
            title: gt("All connected environments"),
            selected: selectedIds === null,
            onPress: selectAll,
          },
          ...availableTargets.map((entry) => ({
            id: `environment:${entry.environmentId}`,
            title: entry.label,
            icon: ENVIRONMENT_MACHINE_SYMBOLS[resolveEnvironmentMachineKind(entry.serverConfig)],
            subtitle: entry.displayUrl ?? undefined,
            selected: selectedIds === null || selectedIds.has(entry.environmentId),
            onPress: () => toggleEnvironment(entry.environmentId),
          })),
        ],
      },
      {
        id: "projects",
        title:
          selectableProjectGroups.find((group) => group.key === selectedProjectKey)?.label ??
          (selectedProjectKey === null ? gt("All projects") : gt("Unavailable project")),
        items: [
          {
            id: "project:all",
            title: gt("All projects"),
            selected: selectedProjectKey === null,
            onPress: () => selectProject(null),
          },
          ...selectableProjectGroups.map((group) => ({
            id: `project:${group.key}`,
            title: group.archived
              ? gt("{project} · Archived", { project: group.label })
              : group.label,
            selected: selectedProjectKey === group.key,
            onPress: () => selectProject(group.key),
          })),
        ],
      },
    ],
  };
}
