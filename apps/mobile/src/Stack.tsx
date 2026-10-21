import { ComponentCatalogScreen } from "./features/development/ComponentCatalogScreen";
import { PullRequestGuideStopScreen } from "./features/pull-requests/guide/PullRequestGuideScreen";
import { PullRequestInlineCommentScreen } from "./features/pull-requests/PullRequestInlineCommentScreen";
import { PullRequestDiscussionScreen } from "./features/pull-requests/PullRequestDiscussionScreen";
import {
  createV5StackNavigator as createNativeStackNavigator,
  createV5SheetStackNavigator,
} from "./native/createV5StackNavigator";
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
import { useEffect, useRef, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "./components/ui/AppText";
import { androidWorkspaceDestinationAnimation } from "./lib/android-workspace-navigation";
import { getCompactBrandHeaderOptions } from "./components/CompactBrandTitle";
import { WorkspaceConnectionStatusProvider } from "./features/home/WorkspaceConnectionTitle";
import { WorkspaceRootScreen } from "./features/workspace/WorkspaceRootScreen";
import { AndroidWorkspaceSettings } from "./features/workspace/AndroidWorkspaceSettings";
import { AndroidWorkspaceTabsProvider } from "./features/workspace/AndroidWorkspaceTabsProvider";
import {
  PullRequestRouteScreen,
  PullRequestFileRouteScreen,
} from "./features/pull-requests/PullRequestRouteScreen";
import { PullRequestFilesSheet } from "./features/pull-requests/PullRequestFiles";
import { PullRequestReviewSheet } from "./features/pull-requests/PullRequestReviewSheet";
import { PullRequestReviewersScreen } from "./features/pull-requests/PullRequestReviewersScreen";
import {
  RenderErrorBoundary,
  RenderFailureView,
  type RenderFailureProps,
} from "./components/RenderErrorBoundary";
import { ArchivedThreadsRouteScreen } from "./features/archive/ArchivedThreadsRouteScreen";
import { useAgentNotificationNavigation } from "./features/agent-awareness/notificationNavigation";
import { ConnectOnboardingRouteScreen } from "./features/cloud/ConnectOnboardingRouteScreen";
import { useConnectOnboardingNavigation } from "./features/cloud/connectOnboardingNavigation";
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
import { ThreadRouteScreen } from "./features/threads/ThreadRouteScreen";
import { McpAppFullscreenScreen } from "./features/threads/McpAppFullscreenScreen";
import { ConnectionsRouteScreen } from "./features/connection/ConnectionsRouteScreen";
import { ConnectionsNewRouteScreen } from "./features/connection/ConnectionsNewRouteScreen";
import { AddProjectDestinationRoute } from "./features/projects/AddProjectDestinationRoute";
import { AddProjectLocalRoute } from "./features/projects/AddProjectLocalRoute";
import { AddProjectNewRoute } from "./features/projects/AddProjectNewRoute";
import { AddProjectRepositoryRoute } from "./features/projects/AddProjectRepositoryRoute";
import { AddProjectSourceRoute } from "./features/projects/AddProjectSourceRoute";
import { NewTaskDraftRouteScreen } from "./features/threads/NewTaskDraftRouteScreen";
import {
  NewTaskBranchPickerRouteScreen,
  NewTaskEnvironmentPickerRouteScreen,
} from "./features/threads/NewTaskContextPickerScreens";
import {
  ExistingThreadSettingsRouteProvider,
  ExistingThreadSettingsRouteScreen,
  NewTaskThreadSettingsRouteScreen,
} from "./features/threads/ThreadSettingsSheet";
import { NewTaskFlowProvider } from "./features/threads/new-task-flow-provider";
import { NewTaskRouteScreen } from "./features/threads/NewTaskRouteScreen";
import { SettingsAppearanceRouteScreen } from "./features/settings/SettingsAppearanceRouteScreen";
import { SettingsClientStorageRouteScreen } from "./features/settings/SettingsClientStorageRouteScreen";
import { SettingsDiagnosticsRouteScreen } from "./features/diagnostics/SettingsDiagnosticsRouteScreen";
import { SettingsProviderAccountsRouteScreen } from "./features/settings/SettingsProviderAccountsRouteScreen";
import { SettingsAuthRouteScreen } from "./features/settings/SettingsAuthRouteScreen";
import { SettingsEnvironmentDetailRouteScreen } from "./features/settings/SettingsEnvironmentDetailRouteScreen";
import { SettingsEnvironmentsRouteScreen } from "./features/settings/SettingsEnvironmentsRouteScreen";
import { SettingsFollowUpRouteScreen } from "./features/settings/SettingsFollowUpRouteScreen";
import {
  SettingsEnvironmentAgentBehaviorRouteScreen,
  SettingsEnvironmentMaintenanceRouteScreen,
  SettingsEnvironmentNewThreadsRouteScreen,
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
import { ScheduledTaskEditorProvider } from "./features/settings/scheduled-task-editor";
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
import { SettingsThreadsRouteScreen } from "./features/settings/SettingsThreadsRouteScreen";
import { SettingsEnvironmentFilterProvider } from "./features/settings/settings-environment-filter";
import { ShowcaseCaptureCoordinator } from "./features/showcase/ShowcaseCaptureCoordinator";
import {
  SettingsLegalDocumentCloseHeaderButton,
  SettingsLegalDocumentExternalHeaderButton,
} from "./features/settings/components/SettingsLegalDocumentRouteScreen";
import { useAppShortcuts } from "./features/shortcuts/useAppShortcuts";
import { useIncomingShare } from "./features/sharing/IncomingShareProvider";
import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  transitionIncomingSharePresentation,
} from "./features/sharing/incoming-share-presentation";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native/native-glass";
import { deriveLayout } from "./lib/layout";
import { useNativeLayoutMetrics } from "./native/native-layout-metrics";
import { nativeHeaderScrollEdgeEffects } from "./native/StackHeader";
import { FORM_SHEET_PRESENTATION_OPTIONS } from "./native/sheet-surface";
import { useThreadOutboxDrain } from "./state/use-thread-outbox-drain";
import { useComposerAttachmentUploadWorker } from "./state/composer-attachment-uploads";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AppScreenOptions = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor";
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

const NESTED_NAVIGATOR_OPTIONS = { nativeContentInsetHorizontally: false, headerShown: false };

const SettingsContentStack = createV5SheetStackNavigator({
  initialRouteName: "Settings",
  screenOptions: {
    ...GLASS_HEADER_OPTIONS,
    unstable_navigationItemStyle: undefined,
  },
  screens: {
    Settings: createNativeStackScreen({
      screen: SettingsRouteScreen,
      linking: "",
      options: {
        title: "Settings",
        // Android draws its own app bar here. Hidden only from inside the screen, the native one
        // showed for the first frame of the Settings tab and pushed the page down.
        headerShown: Platform.OS !== "android",
      },
    }),
    SettingsEnvironments: createNativeStackScreen({
      screen: SettingsEnvironmentsRouteScreen,
      linking: "environments",
      options: {
        title: "Environments",
      },
    }),
    SettingsEnvironmentDetail: createNativeStackScreen({
      screen: SettingsEnvironmentDetailRouteScreen,
      linking: "environments/:environmentId",
      options: { title: "Environment" },
    }),
    SettingsEnvironmentNewThreads: createNativeStackScreen({
      screen: SettingsEnvironmentNewThreadsRouteScreen,
      linking: "new-threads",
      options: { title: "New threads" },
    }),
    SettingsEnvironmentSourceControl: createNativeStackScreen({
      screen: SettingsEnvironmentSourceControlRouteScreen,
      linking: "source-control",
      options: { title: "Source control" },
    }),
    SettingsEnvironmentAgentBehavior: createNativeStackScreen({
      screen: SettingsEnvironmentAgentBehaviorRouteScreen,
      linking: "agent-behavior",
      options: { title: "Agent behavior" },
    }),
    SettingsProviderAccounts: createNativeStackScreen({
      screen: SettingsProviderAccountsRouteScreen,
      linking: "provider-accounts",
      options: { title: "Provider accounts" },
    }),
    SettingsEnvironmentMaintenance: createNativeStackScreen({
      screen: SettingsEnvironmentMaintenanceRouteScreen,
      linking: "maintenance",
      options: { title: "Maintenance" },
    }),
    SettingsNotifications: createNativeStackScreen({
      screen: SettingsNotificationsRouteScreen,
      linking: "notifications",
      options: { title: "Notifications" },
    }),
    SettingsThreads: createNativeStackScreen({
      screen: SettingsThreadsRouteScreen,
      linking: "thread-preferences",
      options: { title: "Thread behavior" },
    }),
    SettingsAbout: createNativeStackScreen({
      screen: SettingsAboutRouteScreen,
      linking: "about",
      options: { title: "About T3 Code" },
    }),
    SettingsEnvironmentNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      linking: "environment-new",
      options: {
        title: "Add Environment",
      },
    }),
    SettingsArchive: createNativeStackScreen({
      screen: ArchivedThreadsRouteScreen,
      linking: "archive",
      options: {
        title: "Archived Threads",
      },
    }),
    SettingsAppearance: createNativeStackScreen({
      screen: SettingsAppearanceRouteScreen,
      linking: "appearance",
      options: {
        title: "Appearance",
      },
    }),
    SettingsProjectGrouping: createNativeStackScreen({
      screen: SettingsProjectGroupingRouteScreen,
      linking: "project-grouping",
      options: {
        title: "Organization",
      },
    }),
    SettingsOrganization: createNativeStackScreen({
      screen: SettingsProjectGroupingRouteScreen,
      linking: "organization",
      options: {
        title: "Organization",
      },
    }),
    SettingsProjectOverview: createNativeStackScreen({
      screen: SettingsProjectOverviewRouteScreen,
      linking: "project",
      options: { title: "Project overview" },
    }),
    SettingsKeyboard: createNativeStackScreen({
      screen: SettingsKeyboardRouteScreen,
      linking: "keyboard",
      options: {
        title: "Keyboard",
      },
    }),
    SettingsMicrophone: createNativeStackScreen({
      screen: SettingsMicrophoneRouteScreen,
      linking: "microphone",
      options: {
        title: "Microphone",
      },
    }),
    SettingsFollowUp: createNativeStackScreen({
      screen: SettingsFollowUpRouteScreen,
      linking: "follow-ups",
      options: {
        title: "Follow-ups",
      },
    }),
    SettingsScheduledTasks: createNativeStackScreen({
      screen: SettingsScheduledTasksRouteScreen,
      linking: "scheduled-tasks",
      options: {
        title: "Scheduled Tasks",
        headerTitleStyle: { fontSize: 16, fontWeight: "800" },
      },
    }),
    SettingsScheduledTaskNew: createNativeStackScreen({
      screen: SettingsScheduledTaskNewRouteScreen,
      linking: "scheduled-tasks/new",
      options: { title: "New scheduled task" },
    }),
    SettingsScheduledTaskEdit: createNativeStackScreen({
      screen: SettingsScheduledTaskEditRouteScreen,
      options: { title: "Edit scheduled task" },
    }),
    SettingsScheduledTaskBranch: createNativeStackScreen({
      screen: ScheduledTaskBranchPickerRouteScreen,
      options: { title: "Base branch" },
    }),
    SettingsScheduledTaskModel: createNativeStackScreen({
      screen: ScheduledTaskModelPickerRouteScreen,
      options: {
        headerShown: false,
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : {
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [1],
              sheetGrabberVisible: true,
            }),
      },
    }),
    SettingsClientStorage: createNativeStackScreen({
      screen: SettingsClientStorageRouteScreen,
      linking: "client-storage",
      options: {
        title: "Client Storage",
      },
    }),
    SettingsDiagnostics: createNativeStackScreen({
      screen: SettingsDiagnosticsRouteScreen,
      linking: "diagnostics",
      options: {
        title: "Diagnostics",
      },
    }),
    // Its params are a tap-time snapshot, not a stable resource address: `now` is the wall-clock
    // of the tap, `environmentIds` is the usage screen's local filter selection, and the window
    // id/kind identify freshly aggregated pools. React Navigation round-trips non-path params
    // through the URL as query strings, so a path here would bake in a permanently stale
    // timestamp and filter.
    SettingsUsageAccount: createNativeStackScreen({
      screen: UsageLimitAccountScreen,
      options: { title: "Account" },
    }),
    SettingsOpenSourceLicenses: createNativeStackScreen({
      screen: SettingsOpenSourceLicensesRouteScreen,
      linking: "open-source-licenses",
      options: {
        title: "Open source licenses",
      },
    }),
    SettingsOpenSourceLicense: createNativeStackScreen({
      screen: SettingsOpenSourceLicenseRouteScreen,
      linking: "open-source-licenses/:entryKey",
      options: {
        title: "License notice",
      },
    }),
    SettingsUsage: createNativeStackScreen({
      screen: UsageRouteScreen,
      linking: "usage",
      options: {
        title: "Usage",
      },
    }),
  },
});

// Keeping bar visibility invariant avoids iOS 26's headerless-to-headered jump.
const SettingsSheetStack = createV5SheetStackNavigator({
  initialRouteName: "SettingsContent",
  screenOptions: {
    headerShown: false,
  },
  screens: {
    SettingsContent: createNativeStackScreen({
      screen: SettingsContentStack,
      options: NESTED_NAVIGATOR_OPTIONS,
      linking: "",
      layout: ({ children }) => (
        <SettingsEnvironmentFilterProvider>
          <ScheduledTaskEditorProvider>{children}</ScheduledTaskEditorProvider>
        </SettingsEnvironmentFilterProvider>
      ),
    }),
    SettingsAuth: createNativeStackScreen({
      screen: SettingsAuthRouteScreen,
      linking: "auth",
    }),
    SettingsWaitlist: createNativeStackScreen({
      screen: SettingsAuthRouteScreen,
      linking: "waitlist",
    }),
  },
});

// A nested stack means a second UINavigationController with its own UINavigationBar, which breaks
// iOS 26's shared-header morphing between Home and Thread (each pair inside one bar morphs;
// across two bars the whole screen slides).
const THREAD_LINKING_PREFIX = "threads/:environmentId/:threadId";

const NewTaskSheetStack = createNativeStackNavigator({
  initialRouteName: "NewTask",
  screenOptions: {
    ...SHEET_GLASS_HEADER_OPTIONS,
    contentStyle: Platform.OS === "ios" ? { backgroundColor: "transparent" } : undefined,
    // UIKit's default push adds a dimming shadow and independently transitions
    // the navigation bar. Both read as mismatched sheet backgrounds here.
    animation: Platform.OS === "ios" ? "simple_push" : undefined,
    animationDuration: Platform.OS === "ios" ? 350 : undefined,
  },
  screens: {
    NewTask: createNativeStackScreen({
      screen: NewTaskRouteScreen,
      linking: "",
      options: {
        title: "Choose project",
      },
    }),
    NewTaskDraft: createNativeStackScreen({
      screen: NewTaskDraftRouteScreen,
      linking: "draft",
      options: {
        headerBackVisible: false,
        title: "",
      },
    }),
    NewTaskEnvironment: createNativeStackScreen({
      screen: NewTaskEnvironmentPickerRouteScreen,
      linking: "draft/environment",
      options: {
        title: "Environment",
      },
    }),
    NewTaskBranch: createNativeStackScreen({
      screen: NewTaskBranchPickerRouteScreen,
      linking: "draft/branch",
      options: {
        title: "Branch",
      },
    }),
    NewTaskFile: createNativeStackScreen({
      screen: ThreadFileScreen,
      linking: "draft/files/:path*",
      options: SOLID_HEADER_OPTIONS,
    }),
    NewTaskAttachment: createNativeStackScreen({
      screen: AttachmentFileScreen,
      linking: "draft/attachments/:attachmentId",
      options: SOLID_HEADER_OPTIONS,
    }),
    ThreadSettings: createNativeStackScreen({
      screen: NewTaskThreadSettingsRouteScreen,
      linking: "draft/settings",
      options: {
        gestureEnabled: true,
        headerShown: false,
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : {
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [1],
              sheetGrabberVisible: true,
            }),
      },
    }),
    AddProject: createNativeStackScreen({
      screen: AddProjectSourceRoute,
      linking: "add-project",
      options: {
        title: "Add Project",
      },
    }),
    AddProjectRepository: createNativeStackScreen({
      screen: AddProjectRepositoryRoute,
      linking: "add-project/repository",
    }),
    AddProjectDestination: createNativeStackScreen({
      screen: AddProjectDestinationRoute,
      linking: "add-project/destination",
    }),
    AddProjectLocal: createNativeStackScreen({
      screen: AddProjectLocalRoute,
      linking: "add-project/local",
    }),
    AddProjectNew: createNativeStackScreen({
      screen: AddProjectNewRoute,
      linking: "add-project/new",
    }),
  },
});

const WORKSPACE_OVERLAY_ROUTES = new Set([
  "PullRequestReview",
  "PullRequestInlineComment",
  "ConnectOnboarding",
  "Connections",
  "ConnectionsNew",
  "GitBranches",
  "GitCommit",
  "GitConfirm",
  "GitOverview",
  "NewTaskSheet",
  "SettingsLegal",
  "SettingsSheet",
  "ThreadAgents",
  "ThreadBackgroundWork",
  "ThreadPullRequests",
  "ThreadQueue",
  "ThreadReviewComment",
  "ThreadDevicePreview",
  "ThreadBrowserPreview",
  "ThreadSettingsSheet",
]);

function workspaceLocationFromState(state: NavigationState) {
  // Android opens Settings as a workspace page rather than an overlay, so the layout sees it.
  const routes = state.routes.filter(
    (route) =>
      !WORKSPACE_OVERLAY_ROUTES.has(route.name) ||
      (Platform.OS === "android" && route.name === "SettingsSheet"),
  );
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

// The drain hook subscribes to the outbox, all thread shells, projects, and
// connection statuses. Hosting it in a null-rendering leaf keeps those
// updates from re-rendering RootStackLayout (and with it every screen) on
// each enqueue, shell change, or reconnect.
function ThreadOutboxDrainWorker() {
  useThreadOutboxDrain();
  useComposerAttachmentUploadWorker();
  return null;
}

function RootStackLayout(props: {
  readonly children: React.ReactNode;
  readonly state: NavigationState;
}) {
  const navigation = useNavigation();
  const { pendingShare } = useIncomingShare();
  const sharePresentationRef = useRef(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);
  const path = getPathFromState(props.state, navigationPathConfig);
  const pathname = path.startsWith("/") ? path : `/${path}`;
  const workspaceLocation = workspaceLocationFromState(props.state);
  useAgentNotificationNavigation(workspaceLocation.pathname);
  useConnectOnboardingNavigation();
  useAppShortcuts(props.state);
  useEffect(() => {
    const topRouteName = props.state.routes[props.state.index]?.name;
    const transition = transitionIncomingSharePresentation(sharePresentationRef.current, {
      isShareSheetPresented: topRouteName === "NewTaskSheet",
      pendingShareId: pendingShare?.id ?? null,
    });
    sharePresentationRef.current = transition.state;
    if (!transition.shareIdToPresent) {
      return;
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTask",
      params: { incomingShareId: transition.shareIdToPresent },
    });
  }, [navigation, pendingShare, props.state]);

  return (
    <HardwareKeyboardCommandProvider pathname={pathname}>
      <ThreadOutboxDrainWorker />
      <ShowcaseCaptureCoordinator pathname={pathname} />
      <ExistingThreadSettingsRouteProvider>
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
      </ExistingThreadSettingsRouteProvider>
    </HardwareKeyboardCommandProvider>
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
  // React Navigation calls layouts as plain functions inside its own render. Passing a
  // compiled component directly would put its memo cache among the navigator's hooks.
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
      options: {
        ...GLASS_HEADER_OPTIONS,
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
      options: DETAIL_HEADER_OPTIONS,
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
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.6, 0.92],
        sheetGrabberVisible: true,
        sheetCornerRadius: Platform.OS === "android" ? 28 : undefined,
      },
    }),
    PullRequestReviewers: createNativeStackScreen({
      screen: PullRequestReviewersScreen,
      options: {
        ...DETAIL_HEADER_OPTIONS,
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.75, 0.92],
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
          : { ...SHEET_GLASS_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS }),
        sheetAllowedDetents: Platform.OS === "android" ? undefined : [0.75, 0.92],
        sheetGrabberVisible: Platform.OS !== "android",
      },
    }),
    PullRequestReview: createNativeStackScreen({
      screen: PullRequestReviewSheet,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.75, 0.92],
        sheetGrabberVisible: true,
      },
    }),
    Thread: createNativeStackScreen({
      screen: ThreadRouteScreen,
      linking: THREAD_LINKING_PREFIX,
      options: DETAIL_HEADER_OPTIONS,
    }),
    ThreadTerminal: createNativeStackScreen({
      screen: ThreadTerminalRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/terminal`,
      options: SOLID_HEADER_OPTIONS,
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
        // Android cannot host the keyboard-driven comment composer inside a
        // formSheet; use a full-screen modal there instead.
        ...(Platform.OS === "android"
          ? { presentation: "fullScreenModal" as const }
          : FORM_SHEET_PRESENTATION_OPTIONS),
        sheetAllowedDetents: Platform.OS === "android" ? undefined : [0.55, 0.92],
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
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [1],
              sheetGrabberVisible: true,
            }),
      },
    }),
    ThreadQueue: createNativeStackScreen({
      screen: ThreadQueueSheet,
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        headerShown: false,
        sheetAllowedDetents: [0.65, 0.95],
        sheetGrabberVisible: true,
      },
    }),
    ThreadBackgroundWork: createNativeStackScreen({
      screen: ThreadBackgroundWorkSheet,
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        headerShown: false,
        sheetAllowedDetents: [0.5, 0.9],
        sheetGrabberVisible: true,
      },
    }),
    ThreadAgents: createNativeStackScreen({
      screen: ThreadAgentsSheet,
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        headerShown: false,
        sheetAllowedDetents: [0.5, 0.9],
        sheetGrabberVisible: true,
      },
    }),
    GitOverview: createNativeStackScreen({
      screen: GitOverviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/git`,
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.55, 0.92],
        sheetGrabberVisible: true,
      },
    }),
    ThreadPullRequests: createNativeStackScreen({
      screen: ThreadPullRequestsSheet,
      linking: `${THREAD_LINKING_PREFIX}/pull-requests`,
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.55, 0.92],
        sheetGrabberVisible: true,
      },
    }),
    GitCommit: createNativeStackScreen({
      screen: GitCommitSheet,
      linking: `${THREAD_LINKING_PREFIX}/git/commit`,
      options: {
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.8, 0.92],
        sheetGrabberVisible: true,
      },
    }),
    GitBranches: createNativeStackScreen({
      screen: GitBranchesSheet,
      linking: `${THREAD_LINKING_PREFIX}/git/branches`,
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.55, 0.92],
        sheetGrabberVisible: true,
      },
    }),
    GitConfirm: createNativeStackScreen({
      screen: GitConfirmSheet,
      linking: `${THREAD_LINKING_PREFIX}/git-confirm`,
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.45, 0.7],
        sheetGrabberVisible: true,
      },
    }),
    SettingsSheet: createNativeStackScreen({
      screen: SettingsSheetStack,
      layout: ({ children }) => <AndroidWorkspaceSettings>{children}</AndroidWorkspaceSettings>,
      linking: "settings",
      options: {
        ...NESTED_NAVIGATOR_OPTIONS,
        gestureEnabled: true,
        headerShown: false,
        // Android opens Settings as a top-level tab, so it swaps like the other tabs.
        ...(Platform.OS === "android" ? { animation: "none" as const } : null),
      },
    }),
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
        // A root-level Android formSheet does not host the native stack bar;
        // the route renders an embedded AndroidSheetHeader instead.
        ...(Platform.OS === "android" ? { headerShown: false } : SHEET_SOLID_HEADER_OPTIONS),
        title: "Set up T3 Connect",
        gestureEnabled: true,
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.6, 0.95],
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
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [0.55, 0.7],
              sheetGrabberVisible: true,
            }),
      },
    }),
    ConnectionsNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      linking: "connections/new",
      options: {
        // Keep the iOS header visible from the first render so the sheet's
        // native header stack mounts without remounting the pairing form.
        ...(Platform.OS === "ios" ? SHEET_GLASS_HEADER_OPTIONS : undefined),
        title: "Add Environment",
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.55, 0.7],
        sheetGrabberVisible: true,
      },
    }),
    NewTaskSheet: createNativeStackScreen({
      screen: NewTaskSheetStack,
      linking: "new",
      // A screen's layout replaces the navigator's screenLayout.
      layout: ({ children, route }) => (
        <GuardedScreenLayout route={route}>
          <NewTaskFlowProvider>
            <View className="flex-1 bg-sheet-solid">{children}</View>
          </NewTaskFlowProvider>
        </GuardedScreenLayout>
      ),
      options: {
        ...NESTED_NAVIGATOR_OPTIONS,
        gestureEnabled: true,
        headerShown: false,
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
      ? { label: "Open settings", onPress: () => navigation.navigate("SettingsSheet") }
      : { label: "Return home", onPress: () => navigation.dispatch(StackActions.replace("Home")) };

  return <RenderFailureView {...props} exit={exit} />;
}

export const RootStack = RootStackConfig.with(function AdaptiveRootStack({ Navigator }) {
  const { width, height } = useWindowDimensions();
  const nativeMetrics = useNativeLayoutMetrics();
  const usesSplitView = deriveLayout({ width, height, nativeMetrics }).usesSplitView;
  const usesWorkspaceFlowScreens = Platform.OS === "android" || usesSplitView;

  return (
    <Navigator
      screenLayout={(props) => <GuardedScreenLayout {...props} />}
      screenOptions={({ route }) => {
        if (route.name !== "SettingsSheet" && route.name !== "NewTaskSheet") {
          return Platform.OS === "android"
            ? { animation: androidWorkspaceDestinationAnimation(route.name, usesSplitView) }
            : {};
        }

        return usesWorkspaceFlowScreens
          ? { presentation: "card" }
          : {
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [0.92],
              sheetGrabberVisible: true,
            };
      }}
    />
  );
});

type RootStackType = typeof RootStack;

const navigationPathConfig = {
  screens: createPathConfigForStaticNavigation(RootStack) ?? {},
};

declare module "@react-navigation/native" {
  interface RootNavigator extends RootStackType {}
}
