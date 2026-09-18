import { useNavigation } from "@react-navigation/native";
import { useWindowDimensions } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { ArchivedThreadsHeaderProps } from "./ArchivedThreadsHeader.types";

export function ArchivedThreadsHeader(props: ArchivedThreadsHeaderProps) {
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const hasCustomFilter = props.selectedEnvironmentId !== null || props.sortOrder !== "newest";
  return (
    <ScreenHeader
      title="Archived threads"
      sidebar={false}
      onBack={() => navigation.goBack()}
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: "Search archived threads",
        compactPlaceholder: "Search",
        mode: "inline",
        compactToolbar: width < 700,
        onRefresh: props.onRefresh,
        refreshInToolbar: true,
        refreshAccessibilityLabel: "Refresh archived threads",
      }}
      menu={{
        title: "Archived thread options",
        icon: hasCustomFilter
          ? "line.3.horizontal.decrease.circle.fill"
          : "line.3.horizontal.decrease.circle",
        items: [
          {
            id: "environment",
            title: "Environment",
            items: [
              {
                id: "environment:all",
                title: "All environments",
                selected: props.selectedEnvironmentId === null,
                onPress: () => props.onEnvironmentChange(null),
              },
              ...props.environments.map((environment) => ({
                id: `environment:${environment.environmentId}`,
                title: environment.label,
                selected: props.selectedEnvironmentId === environment.environmentId,
                onPress: () => props.onEnvironmentChange(environment.environmentId),
              })),
            ],
          },
          {
            id: "sort",
            title: "Sort by archived date",
            items: [
              {
                id: "sort:newest",
                title: "Newest first",
                selected: props.sortOrder === "newest",
                onPress: () => props.onSortOrderChange("newest"),
              },
              {
                id: "sort:oldest",
                title: "Oldest first",
                selected: props.sortOrder === "oldest",
                onPress: () => props.onSortOrderChange("oldest"),
              },
            ],
          },
        ],
      }}
    />
  );
}
