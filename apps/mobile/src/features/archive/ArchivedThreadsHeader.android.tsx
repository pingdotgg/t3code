import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { ArchivedThreadsHeaderProps } from "./ArchivedThreadsHeader.types";

export function ArchivedThreadsHeader(props: ArchivedThreadsHeaderProps) {
  const { onEnvironmentChange, onSortOrderChange } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const hasCustomFilter = props.selectedEnvironmentId !== null || props.sortOrder !== "newest";
  const androidFilterActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            state: props.selectedEnvironmentId === null ? ("on" as const) : undefined,
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              props.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : undefined,
          })),
        ],
      },
      {
        id: "sort",
        title: "Sort by archived date",
        subactions: [
          {
            id: "sort:newest",
            title: "Newest first",
            state: props.sortOrder === "newest" ? ("on" as const) : undefined,
          },
          {
            id: "sort:oldest",
            title: "Oldest first",
            state: props.sortOrder === "oldest" ? ("on" as const) : undefined,
          },
        ],
      },
    ],
    [props.environments, props.selectedEnvironmentId, props.sortOrder],
  );
  const handleAndroidFilterAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const action = event.nativeEvent.event;
      if (action === "environment:all") {
        onEnvironmentChange(null);
      } else if (action.startsWith("environment:")) {
        onEnvironmentChange(action.slice("environment:".length) as EnvironmentId);
      } else if (action === "sort:newest") {
        onSortOrderChange("newest");
      } else if (action === "sort:oldest") {
        onSortOrderChange("oldest");
      }
    },
    [onEnvironmentChange, onSortOrderChange],
  );

  // Single header row matching the app's Android chrome (AndroidScreenHeader
  // palette): back chevron, inline search, filter menu.
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <View
        className="border-b border-header-border bg-header px-3 pb-2.5"
        style={{
          paddingTop: Math.max(insets.top, 12),
          borderBottomWidth: 0,
        }}
      >
        <View className="min-h-12 flex-row items-center gap-2">
          <Pressable
            accessibilityLabel="Navigate up"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            className="size-11 items-center justify-center"
          >
            <SymbolView
              name="chevron.left"
              size={24}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>
          <View className="min-h-11 flex-1 flex-row items-center gap-2.5 rounded-2xl bg-input px-3.5">
            <SymbolView
              name="magnifyingglass"
              size={17}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
            <TextInput
              accessibilityLabel="Search archived threads"
              autoCapitalize="none"
              onChangeText={props.onSearchQueryChange}
              value={props.searchQuery}
              placeholder="Search archived threads"
              placeholderTextColorClassName="accent-placeholder"
              className="flex-1 py-2 text-base font-sans text-foreground"
            />
          </View>
          <ControlPillMenu
            actions={androidFilterActions}
            isAnchoredToRight
            onPressAction={handleAndroidFilterAction}
          >
            <Pressable
              accessibilityLabel="Filter and sort archived threads"
              accessibilityRole="button"
              className="size-11 items-center justify-center rounded-full bg-subtle"
            >
              <SymbolView
                name={
                  hasCustomFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle"
                }
                size={16}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            </Pressable>
          </ControlPillMenu>
        </View>
      </View>
    </>
  );
}
