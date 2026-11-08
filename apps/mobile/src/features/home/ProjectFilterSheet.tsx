import { useMemo, useRef, useState } from "react";
import { FlatList, View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { AppText } from "../../components/ui/AppText";
import { SearchField } from "../../components/ui/SearchField";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { Sheet } from "../../components/ui/Sheet";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { filterProjectOptions, type HomeListFilterMenuProject } from "./home-list-filter-menu";

export function ProjectFilterSheet(props: {
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedProjectKey: string | null;
  readonly onProjectChange: (key: string | null) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<TextInputInstance>(null);
  const insets = useSafeAreaInsets();
  const projects = useMemo(
    () => filterProjectOptions(props.projects, query),
    [props.projects, query],
  );
  const select = (key: string | null) => {
    props.onProjectChange(key);
    props.onClose();
  };
  return (
    <Sheet title="Filter by project" onClose={props.onClose}>
      <FlatList
        renderScrollComponent={(scrollProps) => <NativeScrollView {...scrollProps} />}
        data={projects}
        keyExtractor={(item) => item.key}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 16 }}
        ListHeaderComponent={
          <>
            <View className="flex-row py-3">
              <SearchField
                inputRef={inputRef}
                autoFocus={false}
                accessibilityLabel="Search projects"
                clearAccessibilityLabel="Clear project search"
                placeholder="Search projects"
                value={query}
                onChangeText={setQuery}
              />
            </View>
            <SelectionRow
              title="All projects"
              icon="folder"
              selected={props.selectedProjectKey === null}
              onPress={() => select(null)}
              isFirst
              isLast
            />
            <View className="h-3" />
          </>
        }
        ListEmptyComponent={
          <AppText className="py-6 text-center text-foreground-muted">No matching projects</AppText>
        }
        renderItem={({ item, index }) => (
          <SelectionRow
            title={item.label}
            subtitle={item.project.workspaceRoot}
            selected={item.key === props.selectedProjectKey}
            onPress={() => select(item.key)}
            isFirst={index === 0}
            isLast={index === projects.length - 1}
            leading={
              <ProjectFavicon
                environmentId={item.project.environmentId}
                projectTitle={item.label}
                workspaceRoot={item.project.workspaceRoot}
                faviconPath={item.project.faviconPath}
                projectIcon={item.project.projectIcon}
                size={24}
              />
            }
          />
        )}
      />
    </Sheet>
  );
}
