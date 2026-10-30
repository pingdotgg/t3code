import {
  navigationCustomizationAvailable,
  overflowNavigationTabs,
} from "../workspace/navigation-tab-order";
import {
  NAVIGATION_TAB_ICONS,
  WORKSPACE_TAB_LABELS,
  useNavigationTabOrder,
  useHiddenNavigationTabs,
} from "../workspace/navigation-tabs";
import { currentWorkspaceSelections } from "../workspace/workspace-selection-store";
import { rememberedSettingsPage } from "../workspace/workspace-tab-navigation";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation, useNavigationState } from "@react-navigation/native";
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
import {
  useSettingsEnvironmentMenu,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { filterSettingsSections } from "./settings-search";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";

export function SettingsRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const inSidebar = use(NativePrimaryColumnContext) !== null && layout.usesSplitView;
  // The page open beside the list: the route right above the Settings tab's route. While
  // another tab is open this list stays mounted, hidden, and must keep showing the page Settings
  // reopens on; otherwise returning shows it unselected for a frame before the page arrives.
  const selected = useNavigationState((state) => {
    const list = state.routes.findIndex((route) => route.name === "Settings");
    return list < 0
      ? rememberedSettingsPage(currentWorkspaceSelections())
      : (state.routes[list + 1]?.name ?? null);
  });
  return <SettingsListScreen sidebar={inSidebar} selected={selected} />;
}

export function SettingsListScreen(props: {
  readonly sidebar: boolean;
  readonly selected: string | null;
}) {
  const workspace = useWorkspaceTabs();
  const environmentMenu = useSettingsEnvironmentMenu();
  const inSidebar = props.sidebar;
  const selected = props.selected;
  const sidebar = inSidebar ? { selected } : null;
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <SettingsSidebarContext value={sidebar}>
      <View className="flex-1 bg-screen">
        <SettingsEnvironmentFilterHeader />
        {Platform.OS === "android" ? (
          <SettingsScreen
            title="Settings"
            workspaceRoot={inSidebar}
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
            {content}
          </SettingsScreen>
        ) : (
          content
        )}
      </View>
    </SettingsSidebarContext>
  );
}

type SettingsListRow = ComponentProps<typeof SettingsRow> & { readonly id: string };

interface SettingsListSection {
  readonly title?: string;
  readonly rows: readonly SettingsListRow[];
}

function ConfiguredSettingsRouteScreen() {
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
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
      ]}
    />
  );
}

function LocalSettingsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return <SettingsList connections={[environmentsRow(Object.keys(savedConnectionsById).length)]} />;
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
  const page = (
    target: SettingsPageTarget,
    icon: SettingsListRow["icon"],
    label: string,
    extra?: Pick<SettingsListRow, "disabled" | "value">,
  ): SettingsListRow => ({ id: target, icon, label, target, ...extra });
  const serverPage = (target: SettingsPageTarget, icon: SettingsListRow["icon"], label: string) =>
    page(target, icon, label, { disabled: noServerTargets });
  // The same pages and groups as Settings on web, minus what mobile has no setting for.
  return [
    {
      rows: [
        page("SettingsOrganization", "gearshape", "General"),
        page("SettingsAppearance", "paintbrush", "Appearance"),
        page("SettingsFollowUp", "bubble.left.and.bubble.right", "Chat"),
        ...(navigationCustomizationAvailable()
          ? [page("SettingsNavigation", "line.3.horizontal", "Navigation tabs")]
          : []),
        ...(Platform.OS === "ios"
          ? [
              page("SettingsKeyboard", "keyboard", "Keyboard"),
              page("SettingsMicrophone", "mic", "Microphone"),
            ]
          : []),
      ],
    },
    {
      title: "Agents",
      rows: [
        serverPage("SettingsProviderAccounts", "person.crop.circle", "Providers"),
        serverPage("SettingsThreads", "text.bubble", "Threads"),
        page("SettingsScheduledTasks", "clock", "Scheduled tasks"),
      ],
    },
    {
      title: "Code",
      rows: [
        page(
          "SettingsProjectOverview",
          "folder",
          "Projects",
          selectedProjectKey !== null ? { value: projectLabel } : undefined,
        ),
        serverPage("SettingsEnvironmentSourceControl", "arrow.triangle.branch", "Source control"),
        serverPage("SettingsWorktrees", "square.on.square", "Worktrees"),
      ],
    },
    {
      rows: [
        serverPage("SettingsEnvironmentMaintenance", "arrow.clockwise", "Maintenance"),
        page("SettingsLabs", "sparkles", "Labs"),
        page("SettingsAbout", "info.circle", "About"),
        page("SettingsArchive", "archivebox", "Archive"),
      ],
    },
  ];
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
