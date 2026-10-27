import { isDraftThreadRoute } from "./features/threads/thread-route-state";
import { ComponentCatalogScreen } from "./features/development/ComponentCatalogScreen";
import { PullRequestGuideStopScreen } from "./features/pull-requests/guide/PullRequestGuideScreen";
import { PullRequestInlineCommentScreen } from "./features/pull-requests/PullRequestInlineCommentScreen";
import { PullRequestDiscussionScreen } from "./features/pull-requests/PullRequestDiscussionScreen";
import { createWorkspaceStackNavigator } from "./features/layout/createWorkspaceStackNavigator";
import {
  createPathConfigForStaticNavigation,
  getPathFromState,
  NavigationState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import {
  createNativeStackScreen,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "./components/ui/AppText";
import { androidWorkspaceDestinationAnimation } from "./lib/android-workspace-navigation";
import { getCompactBrandHeaderOptions } from "./components/CompactBrandTitle";
import { WorkspaceConnectionStatusProvider } from "./features/home/WorkspaceConnectionTitle";
import { WorkspaceRootScreen } from "./features/workspace/WorkspaceRootScreen";
import {
  recordHomeFocus,
  recordHomeTransitionEnd,
  recordHomeTransitionStart,
} from "./features/home/home-route-visibility";
import { AndroidWorkspaceTabsProvider } from "./features/workspace/AndroidWorkspaceTabsProvider";
import {
  PullRequestRouteScreen,
  PullRequestFileRouteScreen,
} from "./features/pull-requests/PullRequestRouteScreen";
import { PullRequestFilesSheet } from "./features/pull-requests/PullRequestFiles";
import { PullRequestReviewSheet } from "./features/pull-requests/PullRequestReviewSheet";
import { PullRequestReviewersScreen } from "./features/pull-requests/PullRequestReviewersScreen";
import { PullRequestLabelsScreen } from "./features/pull-requests/PullRequestLabelsScreen";
import { PullRequestEditScreen } from "./features/pull-requests/PullRequestEditScreen";
import { PullRequestFilterSearchScreen } from "./features/pull-requests/PullRequestFilterSearchScreen";
import {
  RenderErrorBoundary,
  RenderFailureView,
  type RenderFailureProps,
} from "./components/RenderErrorBoundary";
import { ArchivedThreadsRouteScreen } from "./features/archive/ArchivedThreadsRouteScreen";
import { ConnectOnboardingRouteScreen } from "./features/cloud/ConnectOnboardingRouteScreen";
import { AttachmentFileScreen } from "./features/files/AttachmentFileScreen";
import { ThreadFilesTreeScreen, ThreadFileScreen } from "./features/files/ThreadFilesRouteScreen";
import { AdaptiveWorkspaceLayout } from "./features/layout/AdaptiveWorkspaceLayout";
import { selectedPullRequestKey } from "./features/pull-requests/pullRequestSelection";
import {
  HardwareKeyboardCommandOverlay,
  HardwareKeyboardCommandProvider,
} from "./features/keyboard/HardwareKeyboardCommandProvider";
import { ReviewCommentComposerSheet } from "./features/review/ReviewCommentComposerSheet";
import { ReviewSheet } from "./features/review/ReviewSheet";
import { ThreadTerminalRouteScreen } from "./features/terminal/ThreadTerminalRouteScreen";
import { DevicePreviewRouteScreen } from "./features/devices/DevicePreviewRouteScreen";
import { BrowserPreviewRouteScreen } from "./features/browser/BrowserPreviewRouteScreen";
import { GitBranchesSheet } from "./features/threads/git/GitBranchesSheet";
import { GitCommitSheet } from "./features/threads/git/GitCommitSheet";
import { GitConfirmSheet } from "./features/threads/git/GitConfirmSheet";
import { GitOverviewSheet } from "./features/threads/git/GitOverviewSheet";
import { ThreadPullRequestsSheet } from "./features/threads/ThreadPullRequestsSheet";
import { ThreadAgentsSheet } from "./features/threads/ThreadAgentsSheet";
import { ThreadBackgroundWorkSheet } from "./features/threads/ThreadBackgroundWorkSheet";
import { ThreadQueueSheet } from "./features/threads/ThreadQueueControl";
import {
  FullscreenThreadRouteScreen,
  ThreadRouteScreen,
} from "./features/threads/ThreadRouteScreen";
import { McpAppFullscreenScreen } from "./features/threads/McpAppFullscreenScreen";
import { ConnectionsRouteScreen } from "./features/connection/ConnectionsRouteScreen";
import { ConnectionsNewRouteScreen } from "./features/connection/ConnectionsNewRouteScreen";
import { AddProjectDestinationRoute } from "./features/projects/AddProjectDestinationRoute";
import { AddProjectLocalRoute } from "./features/projects/AddProjectLocalRoute";
import { AddProjectNewRoute } from "./features/projects/AddProjectNewRoute";
import { AddProjectRepositoryRoute } from "./features/projects/AddProjectRepositoryRoute";
import { AddProjectSourceRoute } from "./features/projects/AddProjectSourceRoute";
import {
  NewTaskBranchPickerRouteScreen,
  NewTaskEnvironmentPickerRouteScreen,
} from "./features/threads/NewTaskContextPickerScreens";
import {
  ExistingThreadSettingsRouteScreen,
  NewTaskThreadSettingsRouteScreen,
} from "./features/threads/ThreadSettingsSheet";
import { NewTaskFlowProvider } from "./features/threads/new-task-flow-provider";
import { NewTaskRouteScreen } from "./features/threads/NewTaskRouteScreen";
import { SettingsNavigationRouteScreen } from "./features/settings/SettingsNavigationRouteScreen";
import { SettingsAppearanceRouteScreen } from "./features/settings/SettingsAppearanceRouteScreen";
import { SettingsClientStorageRouteScreen } from "./features/settings/SettingsClientStorageRouteScreen";
import { SettingsDiagnosticsRouteScreen } from "./features/diagnostics/SettingsDiagnosticsRouteScreen";
import { SettingsProviderAccountsRouteScreen } from "./features/settings/SettingsProviderAccountsRouteScreen";
import { SettingsAuthRouteScreen } from "./features/settings/SettingsAuthRouteScreen";
import { SettingsEnvironmentDetailRouteScreen } from "./features/settings/SettingsEnvironmentDetailRouteScreen";
import { SettingsEnvironmentsRouteScreen } from "./features/settings/SettingsEnvironmentsRouteScreen";
import { SettingsFollowUpRouteScreen } from "./features/settings/SettingsFollowUpRouteScreen";
import {
  SettingsEnvironmentMaintenanceRouteScreen,
  SettingsThreadsRouteScreen,
  SettingsWorktreesRouteScreen,
  SettingsEnvironmentSourceControlRouteScreen,
} from "./features/settings/SettingsServerControlsRouteScreen";
import {
  SettingsScheduledTasksRouteScreen,
  SettingsScheduledTaskNewRouteScreen,
  SettingsScheduledTaskEditRouteScreen,
} from "./features/settings/SettingsScheduledTasksRouteScreen";
import {
  ScheduledTaskModelPickerRouteScreen,
  ScheduledTaskBranchPickerRouteScreen,
} from "./features/settings/ScheduledTaskPickerScreens";
import { SettingsKeyboardRouteScreen } from "./features/settings/SettingsKeyboardRouteScreen";
import { SettingsLegalRouteScreen } from "./features/settings/SettingsLegalRouteScreen";
import { SettingsMicrophoneRouteScreen } from "./features/settings/SettingsMicrophoneRouteScreen";
import {
  SettingsOpenSourceLicenseRouteScreen,
  SettingsOpenSourceLicensesRouteScreen,
} from "./features/settings/SettingsOpenSourceLicensesRouteScreen";
import { SettingsProjectGroupingRouteScreen } from "./features/settings/SettingsProjectGroupingRouteScreen";
import { SettingsProjectOverviewRouteScreen } from "./features/settings/SettingsProjectOverviewRouteScreen";
import { UsageLimitAccountScreen } from "./features/usage/UsageLimitsPooled";
import { UsageRouteScreen } from "./features/usage/UsageRouteScreen";
import { SettingsAboutRouteScreen } from "./features/settings/SettingsAboutRouteScreen";
import { SettingsNotificationsRouteScreen } from "./features/settings/SettingsNotificationsRouteScreen";
import { SettingsRouteScreen } from "./features/settings/SettingsRouteScreen";
import { SettingsLabsRouteScreen } from "./features/settings/ThreadSettingsSections";
import { SettingsEnvironmentFilterProvider } from "./features/settings/settings-environment-filter";
import { openSettings, settingsOpenIn } from "./features/settings/settings-navigation";
import { DEFAULT_SETTINGS_PAGE } from "./features/workspace/workspace-tab-navigation";
import {
  isWorkspaceOverlayRoute,
  registerPresentedRoutes,
} from "./features/layout/workspace-overlay-routes";
import { ShowcaseCaptureCoordinator } from "./features/showcase/ShowcaseCaptureCoordinator";
import {
  SettingsLegalDocumentCloseHeaderButton,
  SettingsLegalDocumentExternalHeaderButton,
} from "./features/settings/components/SettingsLegalDocumentRouteScreen";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native/native-glass";
import { deriveLayout } from "./lib/layout";
import { useNativeLayoutMetrics } from "./native/native-layout-metrics";
import { nativeHeaderScrollEdgeEffects } from "./native/StackHeader";
import { HORIZONTAL_FORM_SHEET_OPTIONS, formSheetDetents } from "./native/sheet-surface";
import { workspaceDetailRouter } from "./features/workspace/workspace-detail-selection";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AppScreenOptions = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor";
  readonly unstable_headerMinimizationBehavior?: "onScrollUp" | "never";
};

const GLASS_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? { backgroundColor: "transparent" } : undefined,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED ? HEADER_SCROLL_EDGE_EFFECTS : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
};

// Hiding Android's native header after mount can leave detail panes measured short.
// These screens render their own Material toolbar, so hide it from the first layout.
const DETAIL_HEADER_OPTIONS: AppScreenOptions = {
  ...GLASS_HEADER_OPTIONS,
  headerShown: Platform.OS !== "android",
};

// Like Messages on the Duo: reading back through history (scrolling up) minimizes the
// header, and reversing toward the latest message restores it. Other devices ignore it.
const THREAD_HEADER_OPTIONS: AppScreenOptions = {
  ...DETAIL_HEADER_OPTIONS,
  unstable_headerMinimizationBehavior: "onScrollUp",
};

// The Duo minimizes headers on scroll down by default. Home and the pull request lists
// stutter against it on hardware (not reproducible in the simulator), so they keep theirs.
const FIXED_DUO_HEADER: AppScreenOptions = { unstable_headerMinimizationBehavior: "never" };

const SOLID_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: false,
  unstable_navigationItemStyle: Platform.OS === "ios" ? "editor" : undefined,
};

const SHEET_SOLID_HEADER_OPTIONS: AppScreenOptions = {
  ...SOLID_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
};

const SHEET_GLASS_HEADER_OPTIONS: AppScreenOptions = {
  ...GLASS_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
};

const LEGAL_DOCUMENT_HEADER_OPTIONS: AppScreenOptions = {
  ...SHEET_SOLID_HEADER_OPTIONS,
  headerBackVisible: false,
  headerLeft: SettingsLegalDocumentCloseHeaderButton,
  headerRight: () => <SettingsLegalDocumentExternalHeaderButton />,
  presentation: "fullScreenModal",
};

// Thread settings keep the Duo's vertical bar so cancel, search, filter and confirm sit in the
// rail. The picker stack spans the sheet so its header reaches the rail, and insets its content.
const THREAD_SETTINGS_SHEET_OPTIONS = {
  presentation: "formSheet" as const,
  sheetAllowedDetents: [1],
  sheetGrabberVisible: true,
  nativeContentInsetHorizontally: false,
};

// Settings pages are root routes so they share the workspace's columns and header. The
// `Settings` route marks the Settings tab as open (see settings-navigation.ts).
const SETTINGS_PAGE_OPTIONS = SHEET_GLASS_HEADER_OPTIONS;

const SETTINGS_SCREENS = {
  Settings: createNativeStackScreen({
    screen: SettingsRouteScreen,
    linking: "settings",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Settings",
      ...(Platform.OS === "android" ? { animation: "none" as const } : {}),
      // Android draws its own app bar here. Hidden only from inside the screen, the native one
      // showed for the first frame of the Settings tab and pushed the page down.
      headerShown: Platform.OS !== "android",
      headerBackVisible: false,
    },
  }),
  SettingsEnvironments: createNativeStackScreen({
    screen: SettingsEnvironmentsRouteScreen,
    linking: "settings/environments",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Environments",
    },
  }),
  SettingsEnvironmentDetail: createNativeStackScreen({
    screen: SettingsEnvironmentDetailRouteScreen,
    linking: "settings/environments/:environmentId",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Environment" },
  }),
  // Old links to New threads and Agent behavior open Threads, which absorbed them.
  SettingsEnvironmentNewThreads: createNativeStackScreen({
    screen: SettingsThreadsRouteScreen,
    linking: "settings/new-threads",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Threads" },
  }),
  SettingsEnvironmentSourceControl: createNativeStackScreen({
    screen: SettingsEnvironmentSourceControlRouteScreen,
    linking: "settings/source-control",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Source control" },
  }),
  SettingsEnvironmentAgentBehavior: createNativeStackScreen({
    screen: SettingsThreadsRouteScreen,
    linking: "settings/agent-behavior",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Threads" },
  }),
  SettingsWorktrees: createNativeStackScreen({
    screen: SettingsWorktreesRouteScreen,
    linking: "settings/worktrees",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Worktrees" },
  }),
  SettingsLabs: createNativeStackScreen({
    screen: SettingsLabsRouteScreen,
    linking: "settings/labs",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Labs" },
  }),
  SettingsProviderAccounts: createNativeStackScreen({
    screen: SettingsProviderAccountsRouteScreen,
    linking: "settings/provider-accounts",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Providers" },
  }),
  SettingsEnvironmentMaintenance: createNativeStackScreen({
    screen: SettingsEnvironmentMaintenanceRouteScreen,
    linking: "settings/maintenance",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Maintenance" },
  }),
  SettingsNotifications: createNativeStackScreen({
    screen: SettingsNotificationsRouteScreen,
    linking: "settings/notifications",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Notifications" },
  }),
  SettingsThreads: createNativeStackScreen({
    screen: SettingsThreadsRouteScreen,
    linking: "settings/thread-preferences",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Threads" },
  }),
  SettingsAbout: createNativeStackScreen({
    screen: SettingsAboutRouteScreen,
    linking: "settings/about",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "About" },
  }),
  SettingsEnvironmentNew: createNativeStackScreen({
    screen: ConnectionsNewRouteScreen,
    linking: "settings/environment-new",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Add Environment",
    },
  }),
  SettingsArchive: createNativeStackScreen({
    screen: ArchivedThreadsRouteScreen,
    linking: "settings/archive",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Archive",
    },
  }),
  SettingsNavigation: createNativeStackScreen({
    screen: SettingsNavigationRouteScreen,
    linking: "settings/navigation-tabs",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Navigation tabs" },
  }),
  SettingsAppearance: createNativeStackScreen({
    screen: SettingsAppearanceRouteScreen,
    linking: "settings/appearance",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Appearance",
    },
  }),
  SettingsProjectGrouping: createNativeStackScreen({
    screen: SettingsProjectGroupingRouteScreen,
    linking: "settings/project-grouping",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "General",
    },
  }),
  SettingsOrganization: createNativeStackScreen({
    screen: SettingsProjectGroupingRouteScreen,
    linking: "settings/organization",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "General",
    },
  }),
  SettingsProjectOverview: createNativeStackScreen({
    screen: SettingsProjectOverviewRouteScreen,
    linking: "settings/project",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Projects" },
  }),
  SettingsKeyboard: createNativeStackScreen({
    screen: SettingsKeyboardRouteScreen,
    linking: "settings/keyboard",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Keyboard",
    },
  }),
  SettingsMicrophone: createNativeStackScreen({
    screen: SettingsMicrophoneRouteScreen,
    linking: "settings/microphone",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Microphone",
    },
  }),
  SettingsFollowUp: createNativeStackScreen({
    screen: SettingsFollowUpRouteScreen,
    linking: "settings/follow-ups",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Chat",
    },
  }),
  SettingsScheduledTasks: createNativeStackScreen({
    screen: SettingsScheduledTasksRouteScreen,
    linking: "settings/scheduled-tasks",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Scheduled tasks",
      headerTitleStyle: { fontSize: 16, fontWeight: "800" },
    },
  }),
  SettingsScheduledTaskNew: createNativeStackScreen({
    screen: SettingsScheduledTaskNewRouteScreen,
    linking: "settings/scheduled-tasks/new",
    options: { ...SETTINGS_PAGE_OPTIONS, title: "New scheduled task" },
  }),
  SettingsScheduledTaskEdit: createNativeStackScreen({
    screen: SettingsScheduledTaskEditRouteScreen,
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Edit scheduled task" },
  }),
  SettingsScheduledTaskBranch: createNativeStackScreen({
    screen: ScheduledTaskBranchPickerRouteScreen,
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Base branch" },
  }),
  SettingsScheduledTaskModel: createNativeStackScreen({
    screen: ScheduledTaskModelPickerRouteScreen,
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      headerShown: false,
      ...(Platform.OS === "android"
        ? { presentation: "card" as const }
        : {
            ...THREAD_SETTINGS_SHEET_OPTIONS,
          }),
    },
  }),
  SettingsClientStorage: createNativeStackScreen({
    screen: SettingsClientStorageRouteScreen,
    linking: "settings/client-storage",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Client Storage",
    },
  }),
  SettingsDiagnostics: createNativeStackScreen({
    screen: SettingsDiagnosticsRouteScreen,
    linking: "settings/diagnostics",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Diagnostics",
    },
  }),
  // These params snapshot the tap time, local filters, and freshly aggregated pools.
  // A linking path would round-trip them as URL query strings and preserve stale values.
  SettingsUsageAccount: createNativeStackScreen({
    screen: UsageLimitAccountScreen,
    options: { ...SETTINGS_PAGE_OPTIONS, title: "Account" },
  }),
  SettingsOpenSourceLicenses: createNativeStackScreen({
    screen: SettingsOpenSourceLicensesRouteScreen,
    linking: "settings/open-source-licenses",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Open source licenses",
    },
  }),
  SettingsOpenSourceLicense: createNativeStackScreen({
    screen: SettingsOpenSourceLicenseRouteScreen,
    linking: "settings/open-source-licenses/:entryKey",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "License notice",
    },
  }),
  SettingsUsage: createNativeStackScreen({
    screen: UsageRouteScreen,
    linking: "settings/usage",
    options: {
      ...SETTINGS_PAGE_OPTIONS,
      title: "Usage",
    },
  }),
  SettingsAuth: createNativeStackScreen({
    screen: SettingsAuthRouteScreen,
    linking: "settings/auth",
    options: { headerShown: false, presentation: "modal" },
  }),
  SettingsWaitlist: createNativeStackScreen({
    screen: SettingsAuthRouteScreen,
    linking: "settings/waitlist",
    options: { headerShown: false, presentation: "modal" },
  }),
};

// iOS 26 header morphing requires one UINavigationBar; nested stacks make the whole screen slide.
const THREAD_LINKING_PREFIX = "threads/:environmentId/:threadId";

export function workspaceLocationFromState(state: NavigationState) {
  const routes = state.routes.filter((route) => !isWorkspaceOverlayRoute(route.name));
  const effectiveState =
    routes.length > 0 && routes.length !== state.routes.length
      ? ({ ...state, routes, index: routes.length - 1 } as NavigationState)
      : state;
  const path = getPathFromState(effectiveState, navigationPathConfig);
  return {
    pathname: path.startsWith("/") ? path : `/${path}`,
    routeKey: effectiveState.routes[effectiveState.index]?.key,
  };
}

function RootStackLayout(props: {
  readonly children: React.ReactNode;
  readonly state: NavigationState;
}) {
  const path = getPathFromState(props.state, navigationPathConfig);
  const pathname = path.startsWith("/") ? path : `/${path}`;
  const workspaceLocation = workspaceLocationFromState(props.state);
  const settingsOpen = settingsOpenIn(
    props.state.routes
      .slice(0, props.state.index + 1)
      .filter((route) => !isWorkspaceOverlayRoute(route.name)),
  );
  const draftRoute = props.state.routes.findLast((route) => route.name === "Thread");
  const draftParams = (
    draftRoute?.params as { draft?: { draftId?: string | string[] } } | undefined
  )?.draft;
  const routeDraftId = Array.isArray(draftParams?.draftId)
    ? draftParams.draftId[0]
    : draftParams?.draftId;

  return (
    <NewTaskFlowProvider active={isDraftThreadRoute(draftRoute)} routeDraftId={routeDraftId}>
      <HardwareKeyboardCommandProvider pathname={pathname}>
        <ShowcaseCaptureCoordinator pathname={pathname} />
        <SettingsEnvironmentFilterProvider open={settingsOpen}>
          <WorkspaceConnectionStatusProvider>
            <AndroidWorkspaceTabsProvider state={props.state}>
              <AdaptiveWorkspaceLayout
                pathname={workspaceLocation.pathname}
                workspaceRouteKey={workspaceLocation.routeKey}
                selectedPullRequestKey={selectedPullRequestKey(props.state)}
              >
                {props.children}
                <HardwareKeyboardCommandOverlay />
              </AdaptiveWorkspaceLayout>
            </AndroidWorkspaceTabsProvider>
          </WorkspaceConnectionStatusProvider>
        </SettingsEnvironmentFilterProvider>
      </HardwareKeyboardCommandProvider>
    </NewTaskFlowProvider>
  );
}

function NotFoundScreen() {
  const navigation = useNavigation();
  const screenBgStyle = StyleSheet.flatten(useResolveClassNames("bg-screen"));
  const primaryBgStyle = StyleSheet.flatten(useResolveClassNames("bg-primary"));
  const returnHomeButtonStyle = StyleSheet.flatten([
    {
      borderRadius: 999,
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    primaryBgStyle,
  ]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      style={[{ flex: 1 }, screenBgStyle]}
    >
      <Text className="text-3xl font-t3-bold text-foreground" selectable>
        Route not found
      </Text>
      <Pressable
        style={returnHomeButtonStyle}
        onPress={() => navigation.dispatch(StackActions.replace("Home"))}
      >
        <Text className="text-base font-t3-bold text-primary-foreground">Return home</Text>
      </Pressable>
    </ScrollView>
  );
}

const RootStackConfig = createWorkspaceStackNavigator({
  initialRouteName: "Home",
  UNSTABLE_router: workspaceDetailRouter,
  // React Navigation calls layouts inline; compiled components would share the navigator's memo cache.
  layout: (props) => <RootStackLayout {...props} />,
  screenOptions: {
    headerShown: false,
  },
  screens: {
    ...(__DEV__
      ? {
          ComponentCatalog: createNativeStackScreen({
            screen: ComponentCatalogScreen,
            linking: "dev/components",
            options: { title: "UI components" },
          }),
        }
      : {}),
    Home: createNativeStackScreen({
      screen: WorkspaceRootScreen,
      linking: "",
      listeners: {
        transitionStart: ({ data }) => recordHomeTransitionStart(data.closing),
        transitionEnd: ({ data }) => recordHomeTransitionEnd(data.closing),
        focus: recordHomeFocus,
      },
      options: {
        ...GLASS_HEADER_OPTIONS,
        ...FIXED_DUO_HEADER,
        contentStyle: { backgroundColor: "transparent" },
        headerBackVisible: false,
        ...getCompactBrandHeaderOptions(),
      },
    }),
    PullRequest: createNativeStackScreen({
      screen: PullRequestRouteScreen,
      linking: {
        path: "pull-requests/:environmentId/:projectId/:repository/:number",
        parse: { number: Number },
      },
      options: { ...DETAIL_HEADER_OPTIONS, ...FIXED_DUO_HEADER },
    }),
    PullRequestGuideStop: createNativeStackScreen({
      screen: PullRequestGuideStopScreen,
      options: DETAIL_HEADER_OPTIONS,
    }),
    PullRequestFile: createNativeStackScreen({
      screen: PullRequestFileRouteScreen,
      options: DETAIL_HEADER_OPTIONS,
    }),
    PullRequestFiles: createNativeStackScreen({
      screen: PullRequestFilesSheet,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.6),
        sheetGrabberVisible: true,
        sheetCornerRadius: Platform.OS === "android" ? 28 : undefined,
      },
    }),
    PullRequestReviewers: createNativeStackScreen({
      screen: PullRequestReviewersScreen,
      options: {
        ...DETAIL_HEADER_OPTIONS,
        ...FIXED_DUO_HEADER,
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.75),
        sheetGrabberVisible: true,
        headerBackVisible: false,
      },
    }),
    PullRequestLabels: createNativeStackScreen({
      screen: PullRequestLabelsScreen,
      // Presented like PullRequestFilterSearch, whose search sheet it shares.
      options:
        Platform.OS === "android"
          ? { presentation: "card", headerShown: false }
          : {
              ...DETAIL_HEADER_OPTIONS,
              ...HORIZONTAL_FORM_SHEET_OPTIONS,
              sheetAllowedDetents: formSheetDetents(0.75),
              sheetGrabberVisible: true,
              headerBackVisible: false,
            },
    }),
    PullRequestFilterSearch: createNativeStackScreen({
      screen: PullRequestFilterSearchScreen,
      // Android pushes it like the branch picker; a formSheet there leaves the list's header
      // peeking above it once the keyboard opens.
      options:
        Platform.OS === "android"
          ? { presentation: "card", headerShown: false }
          : {
              ...DETAIL_HEADER_OPTIONS,
              ...HORIZONTAL_FORM_SHEET_OPTIONS,
              sheetAllowedDetents: formSheetDetents(0.75),
              sheetGrabberVisible: true,
              headerBackVisible: false,
            },
    }),
    PullRequestDiscussion: createNativeStackScreen({
      screen: PullRequestDiscussionScreen,
      options: DETAIL_HEADER_OPTIONS,
    }),
    PullRequestInlineComment: createNativeStackScreen({
      screen: PullRequestInlineCommentScreen,
      options: {
        ...(Platform.OS === "android"
          ? { presentation: "fullScreenModal" as const }
          : { ...SHEET_GLASS_HEADER_OPTIONS, ...HORIZONTAL_FORM_SHEET_OPTIONS }),
        sheetAllowedDetents: Platform.OS === "android" ? undefined : formSheetDetents(0.75),
        sheetGrabberVisible: Platform.OS !== "android",
      },
    }),
    PullRequestReview: createNativeStackScreen({
      screen: PullRequestReviewSheet,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.75),
        sheetGrabberVisible: true,
      },
    }),
    PullRequestEdit: createNativeStackScreen({
      screen: PullRequestEditScreen,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.75),
        sheetGrabberVisible: true,
      },
    }),
    Thread: createNativeStackScreen({
      screen: ThreadRouteScreen,
      linking: { path: "threads/:environmentId?/:threadId?", alias: ["new/draft"] },
      options: THREAD_HEADER_OPTIONS,
    }),
    NewTaskProject: createNativeStackScreen({
      screen: NewTaskRouteScreen,
      linking: { path: "new", alias: ["new/project"] },
      options: { ...GLASS_HEADER_OPTIONS, title: "Choose project" },
    }),
    NewTaskEnvironment: createNativeStackScreen({
      linking: "new/draft/environment",
      screen: NewTaskEnvironmentPickerRouteScreen,
      options: { ...GLASS_HEADER_OPTIONS, title: "Environment" },
    }),
    NewTaskBranch: createNativeStackScreen({
      linking: "new/draft/branch",
      screen: NewTaskBranchPickerRouteScreen,
      options: { ...GLASS_HEADER_OPTIONS, title: "Branch" },
    }),
    AddProject: createNativeStackScreen({
      linking: "new/add-project",
      screen: AddProjectSourceRoute,

      options: {
        ...GLASS_HEADER_OPTIONS,
        title: "Add project",
      },
    }),
    AddProjectRepository: createNativeStackScreen({
      linking: "new/add-project/repository",
      screen: AddProjectRepositoryRoute,
      options: GLASS_HEADER_OPTIONS,
    }),
    AddProjectDestination: createNativeStackScreen({
      linking: "new/add-project/destination",
      screen: AddProjectDestinationRoute,
      options: GLASS_HEADER_OPTIONS,
    }),
    AddProjectLocal: createNativeStackScreen({
      linking: "new/add-project/local",
      screen: AddProjectLocalRoute,
      options: GLASS_HEADER_OPTIONS,
    }),
    AddProjectNew: createNativeStackScreen({
      linking: "new/add-project/new",
      screen: AddProjectNewRoute,
      options: GLASS_HEADER_OPTIONS,
    }),
    NewTaskFiles: createNativeStackScreen({
      linking: "new/draft/files",
      screen: ThreadFilesTreeScreen,
      options: SOLID_HEADER_OPTIONS,
    }),
    NewTaskFile: createNativeStackScreen({
      linking: "new/draft/files/:path*",
      screen: ThreadFileScreen,
      options: SOLID_HEADER_OPTIONS,
    }),
    NewTaskAttachment: createNativeStackScreen({
      screen: AttachmentFileScreen,
      linking: "new/draft/attachments/:attachmentId",
      options: SOLID_HEADER_OPTIONS,
    }),
    NewTaskThreadSettings: createNativeStackScreen({
      screen: NewTaskThreadSettingsRouteScreen,
      linking: "new/draft/settings",
      options: {
        gestureEnabled: true,
        headerShown: false,
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : THREAD_SETTINGS_SHEET_OPTIONS),
      },
    }),
    ThreadTerminal: createNativeStackScreen({
      screen: ThreadTerminalRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/terminal`,
      options: SOLID_HEADER_OPTIONS,
    }),
    ThreadInspectorFullscreen: createNativeStackScreen({
      screen: FullscreenThreadRouteScreen,
      options: {
        ...THREAD_HEADER_OPTIONS,
        presentation: "fullScreenModal",
      },
    }),
    ThreadDevicePreview: createNativeStackScreen({
      screen: DevicePreviewRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/devices`,
      options: {
        presentation: "fullScreenModal",
        headerShown: false,
        gestureEnabled: false,
        autoHideHomeIndicator: true,
        navigationBarHidden: true,
      },
    }),
    ThreadBrowserPreview: createNativeStackScreen({
      screen: BrowserPreviewRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/browser`,
      options: {
        presentation: "fullScreenModal",
        headerShown: false,
        gestureEnabled: false,
      },
    }),
    ThreadReview: createNativeStackScreen({
      screen: ReviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/review`,
      options: GLASS_HEADER_OPTIONS,
    }),
    ThreadReviewComment: createNativeStackScreen({
      screen: ReviewCommentComposerSheet,
      linking: `${THREAD_LINKING_PREFIX}/review-comment`,
      options: {
        // Android formSheets cannot host the keyboard-driven comment composer.
        ...(Platform.OS === "android"
          ? { presentation: "fullScreenModal" as const }
          : HORIZONTAL_FORM_SHEET_OPTIONS),
        sheetAllowedDetents: Platform.OS === "android" ? undefined : formSheetDetents(0.55),
        sheetGrabberVisible: Platform.OS !== "android",
      },
    }),
    ThreadFiles: createNativeStackScreen({
      screen: ThreadFilesTreeScreen,
      linking: `${THREAD_LINKING_PREFIX}/files`,
      options: {
        ...GLASS_HEADER_OPTIONS,
        title: "Files",
      },
    }),
    ThreadFile: createNativeStackScreen({
      screen: ThreadFileScreen,
      linking: `${THREAD_LINKING_PREFIX}/files/:path*`,
      options: GLASS_HEADER_OPTIONS,
    }),
    ThreadMcpApp: createNativeStackScreen({
      screen: McpAppFullscreenScreen,
      linking: `${THREAD_LINKING_PREFIX}/apps/:itemId`,
      options: {
        presentation: "fullScreenModal",
        headerShown: false,
        gestureEnabled: false,
      },
    }),
    ThreadAttachment: createNativeStackScreen({
      screen: AttachmentFileScreen,
      linking: `${THREAD_LINKING_PREFIX}/attachments/:attachmentId`,
      options: SOLID_HEADER_OPTIONS,
    }),
    ThreadSettingsSheet: createNativeStackScreen({
      screen: ExistingThreadSettingsRouteScreen,
      options: {
        gestureEnabled: true,
        headerShown: false,
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : {
              ...THREAD_SETTINGS_SHEET_OPTIONS,
            }),
      },
    }),
    ThreadQueue: createNativeStackScreen({
      screen: ThreadQueueSheet,
      options: {
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        headerShown: false,
        sheetAllowedDetents: formSheetDetents(0.65, 0.95),
        sheetGrabberVisible: true,
      },
    }),
    ThreadBackgroundWork: createNativeStackScreen({
      screen: ThreadBackgroundWorkSheet,
      options: {
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        headerShown: false,
        sheetAllowedDetents: formSheetDetents(0.5, 0.9),
        sheetGrabberVisible: true,
      },
    }),
    ThreadAgents: createNativeStackScreen({
      screen: ThreadAgentsSheet,
      options: {
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        headerShown: false,
        sheetAllowedDetents: formSheetDetents(0.5, 0.9),
        sheetGrabberVisible: true,
      },
    }),
    GitOverview: createNativeStackScreen({
      screen: GitOverviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/git`,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.55),
        sheetGrabberVisible: true,
      },
    }),
    ThreadPullRequests: createNativeStackScreen({
      screen: ThreadPullRequestsSheet,
      linking: `${THREAD_LINKING_PREFIX}/pull-requests`,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.55),
        sheetGrabberVisible: true,
      },
    }),
    GitCommit: createNativeStackScreen({
      screen: GitCommitSheet,
      linking: `${THREAD_LINKING_PREFIX}/git/commit`,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.8),
        sheetGrabberVisible: true,
      },
    }),
    GitBranches: createNativeStackScreen({
      screen: GitBranchesSheet,
      linking: `${THREAD_LINKING_PREFIX}/git/branches`,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.55),
        sheetGrabberVisible: true,
      },
    }),
    GitConfirm: createNativeStackScreen({
      screen: GitConfirmSheet,
      linking: `${THREAD_LINKING_PREFIX}/git-confirm`,
      options: {
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: [0.55, 0.7],
        sheetGrabberVisible: true,
      },
    }),
    ...SETTINGS_SCREENS,
    SettingsLegal: createNativeStackScreen({
      screen: SettingsLegalRouteScreen,
      linking: "settings/legal",
      options: {
        ...LEGAL_DOCUMENT_HEADER_OPTIONS,
        title: "Legal",
      },
    }),
    ConnectOnboarding: createNativeStackScreen({
      screen: ConnectOnboardingRouteScreen,
      linking: "connect-onboarding",
      options: {
        // Android root formSheets lack a native stack bar; the route provides AndroidSheetHeader.
        ...(Platform.OS === "android" ? { headerShown: false } : SHEET_SOLID_HEADER_OPTIONS),
        title: "Set up T3 Connect",
        gestureEnabled: true,
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: formSheetDetents(0.6, 0.95),
        sheetGrabberVisible: true,
      },
    }),
    Connections: createNativeStackScreen({
      screen: ConnectionsRouteScreen,
      linking: "connections",
      options: {
        title: "Environments",
        ...(Platform.OS === "android"
          ? { presentation: "card" as const, headerShown: false }
          : {
              ...HORIZONTAL_FORM_SHEET_OPTIONS,
              sheetAllowedDetents: [0.55, 0.7],
              sheetGrabberVisible: true,
            }),
      },
    }),
    ConnectionsNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      linking: "connections/new",
      options: {
        // Mount the iOS header immediately to avoid remounting the pairing form.
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        title: "Add Environment",
        ...HORIZONTAL_FORM_SHEET_OPTIONS,
        sheetAllowedDetents: [0.55, 0.7],
        sheetGrabberVisible: true,
      },
    }),
    NotFound: createNativeStackScreen({
      screen: NotFoundScreen,
      linking: "*",
    }),
  },
});

function GuardedScreenLayout(props: {
  readonly children: ReactNode;
  readonly route: { readonly name: string; readonly params?: object | undefined };
}) {
  return (
    <RenderErrorBoundary
      resetKeys={[props.route.params]}
      renderFallback={(fallback) => (
        <ScreenRenderFallback {...fallback} routeName={props.route.name} />
      )}
    >
      {props.children}
    </RenderErrorBoundary>
  );
}

function ScreenRenderFallback(props: RenderFailureProps & { readonly routeName: string }) {
  const navigation = useNavigation();
  const exit = navigation.canGoBack()
    ? { label: "Go back", onPress: () => navigation.goBack() }
    : props.routeName === "Home"
      ? // Home itself failed, and the Settings list renders inside it; open a Settings page.
        {
          label: "Open settings",
          onPress: () => openSettings(navigation, DEFAULT_SETTINGS_PAGE),
        }
      : { label: "Return home", onPress: () => navigation.dispatch(StackActions.replace("Home")) };

  return <RenderFailureView {...props} exit={exit} />;
}

registerPresentedRoutes(
  Object.entries(RootStackConfig.config.screens ?? {}).flatMap(([name, screen]) => {
    const options = (screen as { readonly options?: unknown }).options;
    const presentation =
      options && typeof options === "object"
        ? (options as { readonly presentation?: string }).presentation
        : undefined;
    return presentation !== undefined && presentation !== "card" ? [name] : [];
  }),
);

export const RootStack = RootStackConfig.with(function AdaptiveRootStack({ Navigator }) {
  const { width, height } = useWindowDimensions();
  const nativeMetrics = useNativeLayoutMetrics();
  const usesSplitView = deriveLayout({ width, height, nativeMetrics }).usesSplitView;

  /* oxlint-disable react/no-unstable-nested-components -- React Navigation invokes screenLayout as a render callback. */
  return (
    <Navigator
      screenLayout={(props) => <GuardedScreenLayout {...props} />}
      screenOptions={({ route }) =>
        Platform.OS === "android"
          ? { animation: androidWorkspaceDestinationAnimation(route.name, usesSplitView) }
          : {}
      }
    />
  );

  /* oxlint-enable react/no-unstable-nested-components */
});

type RootStackType = typeof RootStack;

const navigationPathConfig = {
  screens: createPathConfigForStaticNavigation(RootStack) ?? {},
};

declare module "@react-navigation/native" {
  interface RootNavigator extends RootStackType {}
}
