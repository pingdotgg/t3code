import {
  DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  type EnvironmentId,
  type SidebarProjectGroupingMode,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { Stack } from "expo-router";
import { useCallback, useMemo, useRef } from "react";
import { Platform, Pressable, Text as RNText, TextInput, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import type { HomeProjectSortOrder } from "./homeThreadList";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import {
  hasCustomHomeListOptions,
  PROJECT_GROUPING_OPTIONS,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";

export interface HomeHeaderEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function HomeHeader(props: {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}) {
  if (Platform.OS === "android") {
    return <AndroidHomeHeader {...props} />;
  }

  return <IosHomeHeader {...props} />;
}

type HomeHeaderProps = Parameters<typeof HomeHeader>[0];

function checkedMenuTitle(checked: boolean, title: string) {
  return checked ? `✓ ${title}` : title;
}

function AndroidHomeHeader(props: HomeHeaderProps) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");
  const headerColor = useThemeColor("--color-header");
  const headerBorderColor = useThemeColor("--color-header-border");
  const inputColor = useThemeColor("--color-input");
  const inputBorderColor = useThemeColor("--color-input-border");
  const placeholderColor = useThemeColor("--color-placeholder");
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null ||
    props.projectSortOrder !== DEFAULT_SIDEBAR_PROJECT_SORT_ORDER ||
    props.threadSortOrder !== DEFAULT_SIDEBAR_THREAD_SORT_ORDER ||
    props.projectGroupingMode !== DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE;
  const menuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: checkedMenuTitle(props.selectedEnvironmentId === null, "All environments"),
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: checkedMenuTitle(
              props.selectedEnvironmentId === environment.environmentId,
              environment.label,
            ),
          })),
        ],
      },
      {
        id: "project-sort",
        title: "Sort projects",
        subactions: PROJECT_SORT_OPTIONS.map((option) => ({
          id: `project-sort:${option.value}`,
          title: checkedMenuTitle(props.projectSortOrder === option.value, option.label),
        })),
      },
      {
        id: "thread-sort",
        title: "Sort threads",
        subactions: THREAD_SORT_OPTIONS.map((option) => ({
          id: `thread-sort:${option.value}`,
          title: checkedMenuTitle(props.threadSortOrder === option.value, option.label),
        })),
      },
      {
        id: "project-grouping",
        title: "Group projects",
        subactions: PROJECT_GROUPING_OPTIONS.map((option) => ({
          id: `project-grouping:${option.value}`,
          title: checkedMenuTitle(props.projectGroupingMode === option.value, option.label),
        })),
      },
    ],
    [
      props.environments,
      props.projectGroupingMode,
      props.projectSortOrder,
      props.selectedEnvironmentId,
      props.threadSortOrder,
    ],
  );
  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "environment:all") {
        props.onEnvironmentChange(null);
        return;
      }

      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length);
        const environment = props.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment) {
          props.onEnvironmentChange(environment.environmentId);
        }
        return;
      }

      const projectSort = PROJECT_SORT_OPTIONS.find(
        (option) => id === `project-sort:${option.value}`,
      );
      if (projectSort) {
        props.onProjectSortOrderChange(projectSort.value);
        return;
      }

      const threadSort = THREAD_SORT_OPTIONS.find((option) => id === `thread-sort:${option.value}`);
      if (threadSort) {
        props.onThreadSortOrderChange(threadSort.value);
        return;
      }

      const grouping = PROJECT_GROUPING_OPTIONS.find(
        (option) => id === `project-grouping:${option.value}`,
      );
      if (grouping) {
        props.onProjectGroupingModeChange(grouping.value);
      }
    },
    [props],
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={{
          backgroundColor: headerColor,
          borderBottomColor: headerBorderColor,
          borderBottomWidth: 1,
          paddingTop: Math.max(insets.top, 12),
          paddingBottom: 12,
          paddingHorizontal: 16,
        }}
      >
        <View style={{ alignSelf: "center", gap: 12, maxWidth: 720, width: "100%" }}>
          <View style={{ alignItems: "center", flexDirection: "row", gap: 10 }}>
            <View style={{ alignItems: "center", flexDirection: "row", flex: 1, gap: 8 }}>
              <RNText
                style={{
                  color: iconColor,
                  fontFamily: "DMSans_700Bold",
                  fontSize: MOBILE_TYPOGRAPHY.title.fontSize,
                  letterSpacing: -0.5,
                }}
              >
                T3 Code
              </RNText>
              <View
                style={{
                  backgroundColor: subtleColor,
                  borderRadius: 99,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                }}
              >
                <RNText
                  style={{
                    color: mutedColor,
                    fontFamily: "DMSans_700Bold",
                    fontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
                    letterSpacing: 1.1,
                    textTransform: "uppercase",
                  }}
                >
                  Alpha
                </RNText>
              </View>
            </View>

            <ControlPillMenu
              actions={menuActions}
              isAnchoredToRight
              onPressAction={handleMenuAction}
            >
              <Pressable
                accessibilityLabel="Filter and sort threads"
                accessibilityRole="button"
                style={{
                  alignItems: "center",
                  backgroundColor: subtleColor,
                  borderRadius: 99,
                  height: 44,
                  justifyContent: "center",
                  width: 44,
                }}
              >
                <SymbolView
                  name={
                    hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  size={18}
                  tintColor={iconColor}
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
            <ControlPill
              accessibilityLabel="Open settings"
              icon="gearshape"
              onPress={props.onOpenSettings}
            />
            <ControlPill
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={props.onStartNewTask}
            />
          </View>

          <View
            style={{
              alignItems: "center",
              backgroundColor: inputColor,
              borderColor: inputBorderColor,
              borderRadius: 16,
              borderWidth: 1,
              flexDirection: "row",
              gap: 10,
              minHeight: 48,
              paddingHorizontal: 14,
            }}
          >
            <SymbolView name="magnifyingglass" size={17} tintColor={mutedColor} type="monochrome" />
            <TextInput
              accessibilityLabel="Search threads"
              autoCapitalize="none"
              onChangeText={props.onSearchQueryChange}
              placeholder="Search threads"
              placeholderTextColor={placeholderColor}
              style={{
                color: iconColor,
                flex: 1,
                fontFamily: "DMSans_400Regular",
                fontSize: MOBILE_TYPOGRAPHY.body.fontSize,
                paddingVertical: 10,
              }}
              value={props.searchQuery}
            />
            {props.searchQuery.length > 0 ? (
              <Pressable
                accessibilityLabel="Clear search"
                hitSlop={10}
                onPress={() => props.onSearchQueryChange("")}
              >
                <SymbolView
                  name="xmark.circle.fill"
                  size={17}
                  tintColor={mutedColor}
                  type="monochrome"
                />
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </>
  );
}

function IosHomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");
  const hasCustomListOptions = hasCustomHomeListOptions(props);
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          headerShadowVisible: false,
          headerTintColor: iconColor,
          headerTitle: "",
          headerSearchBarOptions: {
            ref: searchBarRef,
            placeholder: "Search threads",
            hideNavigationBar: false,
            onChangeText: (event) => {
              props.onSearchQueryChange(event.nativeEvent.text);
            },
            onCancelButtonPress: () => {
              props.onSearchQueryChange("");
            },
            allowToolbarIntegration: true,
          },
        }}
      />

      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <View
            style={{
              width: 128,
              height: 32,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <RNText
              style={{
                fontFamily: "DMSans_700Bold",
                fontSize: MOBILE_TYPOGRAPHY.headline.fontSize,
                color: iconColor,
                letterSpacing: -0.4,
              }}
            >
              T3 Code
            </RNText>
            <View
              style={{
                backgroundColor: subtleColor,
                borderRadius: 99,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <RNText
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
                  color: mutedColor,
                  letterSpacing: 1.1,
                  textTransform: "uppercase",
                }}
              >
                Alpha
              </RNText>
            </View>
          </View>
        </Stack.Toolbar.View>
      </Stack.Toolbar>

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          accessibilityLabel="Filter and sort threads"
          icon={
            hasCustomListOptions
              ? "line.3.horizontal.decrease.circle.fill"
              : "line.3.horizontal.decrease.circle"
          }
          separateBackground
          title="Thread list options"
        >
          <Stack.Toolbar.Menu title="Environment">
            <Stack.Toolbar.Label>Environment</Stack.Toolbar.Label>
            <Stack.Toolbar.MenuAction
              isOn={props.selectedEnvironmentId === null}
              onPress={() => props.onEnvironmentChange(null)}
              subtitle="Show threads from every environment"
            >
              <Stack.Toolbar.Label>All environments</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
            {props.environments.map((environment) => (
              <Stack.Toolbar.MenuAction
                key={environment.environmentId}
                isOn={props.selectedEnvironmentId === environment.environmentId}
                onPress={() => props.onEnvironmentChange(environment.environmentId)}
              >
                <Stack.Toolbar.Label>{environment.label}</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>

          <Stack.Toolbar.Menu title="Sort projects">
            <Stack.Toolbar.Label>Sort projects</Stack.Toolbar.Label>
            {PROJECT_SORT_OPTIONS.map((option) => (
              <Stack.Toolbar.MenuAction
                key={option.value}
                isOn={props.projectSortOrder === option.value}
                onPress={() => props.onProjectSortOrderChange(option.value)}
              >
                <Stack.Toolbar.Label>{option.label}</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>

          <Stack.Toolbar.Menu title="Sort threads">
            <Stack.Toolbar.Label>Sort threads</Stack.Toolbar.Label>
            {THREAD_SORT_OPTIONS.map((option) => (
              <Stack.Toolbar.MenuAction
                key={option.value}
                isOn={props.threadSortOrder === option.value}
                onPress={() => props.onThreadSortOrderChange(option.value)}
              >
                <Stack.Toolbar.Label>{option.label}</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>

          <Stack.Toolbar.Menu title="Group projects">
            <Stack.Toolbar.Label>Group projects</Stack.Toolbar.Label>
            {PROJECT_GROUPING_OPTIONS.map((option) => (
              <Stack.Toolbar.MenuAction
                key={option.value}
                isOn={props.projectGroupingMode === option.value}
                onPress={() => props.onProjectGroupingModeChange(option.value)}
                subtitle={option.subtitle}
              >
                <Stack.Toolbar.Label>{option.label}</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>

        <Stack.Toolbar.Button
          accessibilityLabel="Open settings"
          icon="gearshape"
          onPress={props.onOpenSettings}
          separateBackground
        />
      </Stack.Toolbar>

      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.SearchBarSlot />
        <Stack.Toolbar.Spacer width={8} sharesBackground={false} />
        <Stack.Toolbar.Button
          accessibilityLabel="New task"
          icon="square.and.pencil"
          onPress={props.onStartNewTask}
          separateBackground
        />
      </Stack.Toolbar>
    </>
  );
}
