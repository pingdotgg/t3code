import { overflowNavigationTabs } from "../layout/workspace/navigation-tab-order";
import {
  NAVIGATION_TAB_ICONS,
  WORKSPACE_TAB_LABELS,
  useNavigationTabOrder,
  useHiddenNavigationTabs,
} from "../layout/workspace/navigation-tabs";
import { currentWorkspaceSelections } from "../layout/workspace/workspace-selection-store";
import { rememberedSettingsPage } from "../layout/workspace/workspace-tab-navigation";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import Constants from "expo-constants";
import { use, type ComponentProps } from "react";
import { Platform, View } from "react-native";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection, SettingsSidebarContext } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import type { SettingsPageTarget } from "./components/settings-page-targets";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { mobileSettingsIndexGroups } from "./settings-catalog";
import { filterSettingsSections } from "./settings-search";
import { usePaneRole } from "../../components/ui/Pane";

export function SettingsRouteScreen() {
  const list = useSettingsListPlacement();
  return <SettingsListScreen sidebar={list.sidebar} selected={list.selected} />;
}

/** The Settings list inside a workspace shell that draws its bar, title and search itself. */
export function WorkspaceSettingsList() {
  const list = useSettingsListPlacement();
  return (
    <SettingsSidebarContext value={list.sidebar ? { selected: list.selected } : null}>
      <View className="flex-1 bg-screen">
        <SettingsListContent />
      </View>
    </SettingsSidebarContext>
  );
}

function useSettingsListPlacement() {
  const sidebar = usePaneRole() === "sidebar";
  // The page open beside the list: the route right above the Settings tab's route. While
  // another tab is open this list stays mounted, hidden, and must keep showing the page Settings
  // reopens on; otherwise returning shows it unselected for a frame before the page arrives.
  const selected = useNavigationState((state) => {
    const list = state.routes.findIndex((route) => route.name === "Settings");
    return list < 0
      ? rememberedSettingsPage(currentWorkspaceSelections())
      : (state.routes[list + 1]?.name ?? null);
  });
  return { sidebar, selected };
}

function SettingsListContent() {
  return hasCloudPublicConfig() ? <ConfiguredSettingsRouteScreen /> : <LocalSettingsRouteScreen />;
}

export function SettingsListScreen(props: {
  readonly sidebar: boolean;
  readonly selected: string | null;
}) {
  const workspace = useWorkspaceTabs();
  const environmentMenu = useSettingsEnvironmentMenu();
  return (
    <SettingsSidebarContext value={props.sidebar ? { selected: props.selected } : null}>
      <View className="flex-1 bg-screen">
        <SettingsScreen
          title="Settings"
          workspaceRoot={props.sidebar}
          menus={[environmentMenu]}
          search={
            workspace
              ? {
                  value: workspace.state.tabs.settings.query,
                  onChangeText: (query) =>
                    workspace.dispatch({ type: "query", tab: "settings", query }),
                  placeholder: "Search settings",
                }
              : undefined
          }
        >
          <SettingsListContent />
        </SettingsScreen>
      </View>
    </SettingsSidebarContext>
  );
}

type SettingsListRow = ComponentProps<typeof SettingsRow> & { readonly id: string };

interface SettingsListSection {
  readonly title?: string;
  readonly rows: readonly SettingsListRow[];
}

function useConnectionExtraRows(): SettingsListRow[] {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const secretsFeatureEnabled = Constants.expoConfig?.extra?.secretsFeatureEnabled === true;
  return [
    {
      id: "access",
      icon: "exclamationmark.shield",
      label: "Sharing & access",
      target: "SettingsAccess",
      disabled: noServerTargets,
    },
    ...(secretsFeatureEnabled
      ? [
          {
            id: "secrets",
            icon: "exclamationmark.shield",
            label: "Secrets",
            target: "SettingsSecrets" as const,
            disabled: noServerTargets,
          } satisfies SettingsListRow,
        ]
      : []),
  ];
}

function ConfiguredSettingsRouteScreen() {
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connectionExtras = useConnectionExtraRows();
  const accountLabel = !isLoaded
    ? "Checking"
    : !isSignedIn
      ? "Sign in"
      : (user?.primaryEmailAddress?.emailAddress ?? "Signed in");

  return (
    <SettingsList
      connections={[
        {
          id: "account",
          icon: "person.crop.circle",
          label: "T3 Account",
          value: accountLabel,
          disabled: !isLoaded,
          onPress: () => navigation.navigate("SettingsAuth"),
        },
        environmentsRow(Object.keys(savedConnectionsById).length),
        {
          id: "SettingsNotifications",
          icon: "bell.badge",
          label: "Notifications",
          target: "SettingsNotifications",
        },
        ...connectionExtras,
      ]}
    />
  );
}

function LocalSettingsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connectionExtras = useConnectionExtraRows();
  return (
    <SettingsList
      connections={[environmentsRow(Object.keys(savedConnectionsById).length), ...connectionExtras]}
    />
  );
}

function environmentsRow(count: number): SettingsListRow {
  return {
    id: "SettingsEnvironments",
    icon: "desktopcomputer",
    label: "Environments",
    value: `${count}`,
    valuePosition: "trailing",
    target: "SettingsEnvironments",
  };
}

function SettingsList(props: { readonly connections: readonly SettingsListRow[] }) {
  // UIKit's scroll-edge material takes the scroll view's own color; like the chat list, match
  // the sidebar's surface so the bar doesn't darken over content at rest.
  // Grouped cards only lift off the screen surface; the drawer is as dark as they are.
  const listSurface = use(SettingsSidebarContext) ? "bg-drawer" : "bg-screen";
  const insets = useSafeAreaInsets();
  // UIKit insets the scroll view by its column's safe area, which this context can report as 0.
  const bottomSafeArea = useNativeColumnLayoutMetrics()?.safeArea.bottom ?? insets.bottom;
  const workspace = useWorkspaceTabs();
  const query = workspace?.state.tabs.settings.query ?? "";
  const overflowRows = useOverflowRows();
  const indexSections = useSettingsIndexSections();
  const sections = filterSettingsSections(
    [{ rows: overflowRows }, { title: "Connections", rows: props.connections }, ...indexSections],
    query,
  );

  return (
    <View collapsable={false} className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className={`flex-1 ${listSurface}`}
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          // The workspace's clearance keeps the last row above its search field and keyboard.
          paddingBottom:
            Platform.OS === "ios"
              ? Math.max(Math.max(bottomSafeArea, 18) + 18, workspace?.bottomClearance ?? 0) -
                bottomSafeArea
              : Math.max(Math.max(insets.bottom, 18) + 18, workspace?.bottomClearance ?? 0),
        }}
      >
        {sections.length ? (
          sections.map((section, index) => (
            <SettingsSection key={section.title ?? `untitled-${index}`} title={section.title}>
              {section.rows.map(({ id, ...row }) => (
                <SettingsRow key={id} {...row} />
              ))}
            </SettingsSection>
          ))
        ) : (
          <EmptyState
            variant="plain"
            title="No results"
            detail={`No settings match “${query.trim()}”.`}
          />
        )}
      </ScrollView>
    </View>
  );
}

function useSettingsIndexSections(): SettingsListSection[] {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  const secretsFeatureEnabled = Constants.expoConfig?.extra?.secretsFeatureEnabled === true;

  return mobileSettingsIndexGroups({ secretsFeatureEnabled }).map((group) => ({
    title: group.title,
    rows: group.rows.map((row) => ({
      id: row.id,
      icon: row.icon as SettingsListRow["icon"],
      label: row.label,
      target: row.target as SettingsPageTarget,
      ...(row.serverOwned ? { disabled: noServerTargets } : {}),
      ...(row.target === "SettingsProjectOverview" && selectedProjectKey !== null
        ? { value: projectLabel }
        : {}),
    })),
  }));
}

function useOverflowRows(): SettingsListRow[] {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const tabs =
    Platform.OS === "android" && layout.usesSplitView ? [] : overflowNavigationTabs(order, hidden);
  const selectTab = useSelectWorkspaceTab();
  return tabs.map((tab) => ({
    id: tab,
    icon: NAVIGATION_TAB_ICONS[tab],
    label: WORKSPACE_TAB_LABELS[tab],
    onPress: () => selectTab(tab),
  }));
}
