import { Pressable, ScrollView } from "react-native";
import { useState } from "react";
import { Chip } from "../../components/ui/Chip";
import { ProjectFilterSheet } from "./ProjectFilterSheet";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
} from "./home-list-filter-menu";

export function ThreadListFilters(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  /** List padding the scroller bleeds through so pills start where row content does. */
  readonly gutter: number;
}) {
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const { themeAppearance } = useAppearancePreferences();
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -props.gutter, overflow: "visible" }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, gap: 8 }}
      >
        <ListFilterMenu
          label={selectedEnvironment?.label ?? "All environments"}
          accessibilityLabel="Filter threads by environment"
          active={selectedEnvironment !== undefined}
          actions={[
            {
              id: "all",
              title: "All environments",
              state: props.selectedEnvironmentId === null ? "on" : "off",
            },
            ...props.environments.map((environment) => ({
              id: JSON.stringify(environment.environmentId),
              title: environment.label,
              state:
                environment.environmentId === props.selectedEnvironmentId
                  ? ("on" as const)
                  : ("off" as const),
            })),
          ]}
          onSelect={(id) => {
            if (id === "all") props.onEnvironmentChange(null);
            else {
              const environment = props.environments.find(
                (candidate) => JSON.stringify(candidate.environmentId) === id,
              );
              if (environment) props.onEnvironmentChange(environment.environmentId);
            }
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Filter threads by project"
          accessibilityState={{ selected: selectedProject !== undefined }}
          hitSlop={6}
          onPress={() => setProjectPickerOpen(true)}
        >
          <Chip
            label={selectedProject?.label ?? "All projects"}
            selected={selectedProject !== undefined}
            trailingIcon="chevron.down"
            glass
            colorScheme={themeAppearance}
          />
        </Pressable>
        {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset thread filters"
            className="h-8 w-8 items-center justify-center"
            onPress={() => {
              props.onEnvironmentChange(null);
              props.onProjectChange(null);
            }}
          >
            <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
      </ScrollView>
      {projectPickerOpen ? (
        <ProjectFilterSheet
          projects={props.projects}
          selectedProjectKey={props.selectedProjectKey}
          onProjectChange={props.onProjectChange}
          onClose={() => setProjectPickerOpen(false)}
        />
      ) : null}
    </>
  );
}
