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
import { newTaskFlowKey } from "./features/threads/new-task-flow-state";
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
import { ShowcaseReadyMarker } from "./features/showcase/ShowcaseCaptureCoordinator";
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
import { DETAIL_HEADER_OPTIONS, FIXED_DUO_HEADER, GLASS_HEADER_OPTIONS, LEGAL_DOCUMENT_HEADER_OPTIONS, NotFoundScreen, RootStackLayout, SETTINGS_SCREENS, SHEET_GLASS_HEADER_OPTIONS, SHEET_SOLID_HEADER_OPTIONS, SOLID_HEADER_OPTIONS, THREAD_HEADER_OPTIONS, THREAD_LINKING_PREFIX, THREAD_SETTINGS_SHEET_OPTIONS } from "./Stack";

export const RootStackConfig = createWorkspaceStackNavigator({
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
        sheetCornerRadius: Platform.OS === "android" ? 28 : undefined,
      },
    }),
    NotFound: createNativeStackScreen({
      screen: NotFoundScreen,
      linking: "*",
    }),
  },
});

