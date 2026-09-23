import {
  createPathConfigForStaticNavigation,
  getPathFromState,
  NavigationState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
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

import { AppText as Text } from "./components/AppText";
import { getCompactBrandHeaderOptions } from "./components/CompactBrandTitle";
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
import {
  HardwareKeyboardCommandOverlay,
  HardwareKeyboardCommandProvider,
} from "./features/keyboard/HardwareKeyboardCommandProvider";
import { ReviewCommentComposerSheet } from "./features/review/ReviewCommentComposerSheet";
import { ReviewSheet } from "./features/review/ReviewSheet";
import { ThreadTerminalRouteScreen } from "./features/terminal/ThreadTerminalRouteScreen";
import { DevicePreviewRouteScreen } from "./features/devices/DevicePreviewRouteScreen";
import { GitBranchesSheet } from "./features/threads/git/GitBranchesSheet";
import { GitCommitSheet } from "./features/threads/git/GitCommitSheet";
import { GitConfirmSheet } from "./features/threads/git/GitConfirmSheet";
import { GitOverviewSheet } from "./features/threads/git/GitOverviewSheet";
import { ThreadRouteScreen } from "./features/threads/ThreadRouteScreen";
import { ConnectionsRouteScreen } from "./features/connection/ConnectionsRouteScreen";
import { ConnectionsNewRouteScreen } from "./features/connection/ConnectionsNewRouteScreen";
import { HomeRouteScreen } from "./features/home/HomeRouteScreen";
import { AddProjectDestinationRoute } from "./features/projects/AddProjectDestinationRoute";
import { AddProjectLocalRoute } from "./features/projects/AddProjectLocalRoute";
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
import { SettingsAuthRouteScreen } from "./features/settings/SettingsAuthRouteScreen";
import { SettingsEnvironmentsRouteScreen } from "./features/settings/SettingsEnvironmentsRouteScreen";
import {
  SettingsEnvironmentAgentBehaviorRouteScreen,
  SettingsEnvironmentMaintenanceRouteScreen,
  SettingsEnvironmentNewThreadsRouteScreen,
  SettingsEnvironmentSourceControlRouteScreen,
} from "./features/settings/SettingsServerControlsRouteScreen";
import { SettingsExtensionsRouteScreen } from "./features/settings/SettingsExtensionsRouteScreen";
import { SettingsKeyboardRouteScreen } from "./features/settings/SettingsKeyboardRouteScreen";
import { SettingsLegalRouteScreen } from "./features/settings/SettingsLegalRouteScreen";
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
import { nativeHeaderScrollEdgeEffects } from "./native/StackHeader";
import { FORM_SHEET_PRESENTATION_OPTIONS } from "./native/sheet-surface";
import { useThreadOutboxDrain } from "./state/use-thread-outbox-drain";
import { useComposerAttachmentUploadWorker } from "./state/composer-attachment-uploads";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AppScreenOptions = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor";
};

// Shared header presets. Screens only override genuinely dynamic values (titles,
// subtitles, toolbar items, search callbacks) via NativeStackScreenOptions.
//
// GLASS: transparent header over the screen's primary scroll view on supported
// iOS versions. Pre-glass iOS gets the same solid material as internal-scroll
// surfaces so content is laid out below the bar instead of underlapping it.
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

// SOLID: opaque sheet-colored header for surfaces whose content scrolls internally
// (file viewer, terminal, review) — there is nothing for glass to sample there.
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

// Solid header variant for screens inside sheets (centered title, no editor style).
const SHEET_SOLID_HEADER_OPTIONS: AppScreenOptions = {
  ...SOLID_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
};

// A native glass header for a sheet screen whose primary child is a scroll
// view. The centered sheet title stays stable while UIKit supplies scroll-edge
// fading from that child.
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

const SettingsContentStack = createNativeStackNavigator({
  initialRouteName: "Settings",
  screenOptions: {
    ...GLASS_HEADER_OPTIONS,
    // Sheets read better with the iOS-default centered title (no editor style).
    unstable_navigationItemStyle: undefined,
  },
  screens: {
    Settings: createNativeStackScreen({
      screen: SettingsRouteScreen,
      linking: "",
      options: {
        title: "Settings",
      },
    }),
    SettingsEnvironments: createNativeStackScreen({
      screen: SettingsEnvironmentsRouteScreen,
      linking: "environments",
      options: {
        title: "Environments",
      },
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
    SettingsExtensions: createNativeStackScreen({
      screen: SettingsExtensionsRouteScreen,
      linking: "extensions",
      options: { title: "Extensions" },
    }),
    SettingsKeyboard: createNativeStackScreen({
      screen: SettingsKeyboardRouteScreen,
      linking: "keyboard",
      options: {
        title: "Keyboard",
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
    // Deliberately the one settings screen with no `linking:` path. Its params
    // are a tap-time snapshot, not a stable resource address: `now` is the
    // wall-clock of the tap, `environmentIds` is the usage screen's local
    // filter selection, and the window id/kind identify freshly aggregated
    // pools. React Navigation round-trips non-path params through the URL as
    // query strings, so a path here would bake in a permanently stale
    // timestamp and filter. The deep linkable surface is the list at
    // `settings/usage`, which rebuilds this state and pushes the detail from a
    // tapped account segment.
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

// The outer stack never owns visible chrome. Settings routes render inside a
// nested stack whose native header remains mounted, while Clerk owns auth chrome.
// Keeping bar visibility invariant avoids iOS 26's headerless-to-headered jump.
const SettingsSheetStack = createNativeStackNavigator({
  initialRouteName: "SettingsContent",
  screenOptions: {
    headerShown: false,
  },
  screens: {
    SettingsContent: createNativeStackScreen({
      screen: SettingsContentStack,
      linking: "",
      layout: ({ children }) => (
        <SettingsEnvironmentFilterProvider>{children}</SettingsEnvironmentFilterProvider>
      ),
    }),
    SettingsAuth: createNativeStackScreen({
      screen: SettingsAuthRouteScreen,
      linking: "auth",
    }),
    SettingsWaitlist: createNativeStackScreen({
      // Keep the old deep link working after the Connect GA launch.
      screen: SettingsAuthRouteScreen,
      linking: "waitlist",
    }),
  },
});

// Thread routes live FLAT in the root stack (not in a nested navigator). A nested
// stack means a second UINavigationController with its own UINavigationBar, which
// breaks iOS 26's shared-header morphing between Home and Thread (each pair inside
// one bar morphs; across two bars the whole screen slides). Flat linking paths keep
// the same deep-link URLs the nested config produced.
const THREAD_LINKING_PREFIX = "threads/:environmentId/:threadId";

// New-task / add-project flow: the nested navigator owns the header and pushes
// whether the flow opens in the workspace or in a compact form sheet.
const NewTaskSheetStack = createNativeStackNavigator({
  initialRouteName: "NewTask",
  screenOptions: {
    ...SHEET_GLASS_HEADER_OPTIONS,
    // The form-sheet host owns the one opaque adaptive surface. Child screens
    // and the navigation bar stay transparent over it, avoiding visible color
    // slabs as view controllers move horizontally.
    contentStyle: Platform.OS === "ios" ? { backgroundColor: "transparent" } : undefined,
    // UIKit's default push adds a dimming shadow and independently transitions
    // the navigation bar. Both read as mismatched sheet backgrounds here.
    // simple_push retains native push/pop gestures without either artifact.
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
    // The same file view the thread composer pushes. A draft has no thread, so it names its
    // own workspace through route params instead of resolving one from a selected thread.
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
  },
});

// Routes presented as sheets/overlays ON TOP of the workspace. They must not
// influence the adaptive workspace layout: opening Settings over Home should
// not flip the sidebar in or change the active thread.
const WORKSPACE_OVERLAY_ROUTES = new Set([
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
  "ThreadReviewComment",
  "ThreadDevicePreview",
  "ThreadSettingsSheet",
]);

/**
 * Location of the topmost non-overlay route, including its key so thread
 * selection can dismiss sheets without replacing the wrong destination.
 */
function workspaceLocationFromState(state: NavigationState) {
  const routes = state.routes.filter((route) => !WORKSPACE_OVERLAY_ROUTES.has(route.name));
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
  useAgentNotificationNavigation();
  // Presents the T3 Connect onboarding sheet after an in-session sign-in.
  useConnectOnboardingNavigation();
  // Launcher app shortcuts: routes shortcut taps and tracks opened threads.
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
  // Full pathname (sheets included) for keyboard-command scoping; the
  // workspace layout only reacts to the underlying non-overlay route.
  const path = getPathFromState(props.state, navigationPathConfig);
  const pathname = path.startsWith("/") ? path : `/${path}`;
  const workspaceLocation = workspaceLocationFromState(props.state);

  return (
    <HardwareKeyboardCommandProvider pathname={pathname}>
      <ThreadOutboxDrainWorker />
      <ShowcaseCaptureCoordinator pathname={pathname} />
      <ExistingThreadSettingsRouteProvider>
        <AdaptiveWorkspaceLayout
          pathname={workspaceLocation.pathname}
          workspaceRouteKey={workspaceLocation.routeKey}
        >
          {props.children}
          <HardwareKeyboardCommandOverlay />
        </AdaptiveWorkspaceLayout>
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

const RootStackConfig = createNativeStackNavigator({
  initialRouteName: "Home",
  layout: RootStackLayout,
  screenOptions: {
    headerShown: false,
  },
  screens: {
    Home: createNativeStackScreen({
      screen: HomeRouteScreen,
      linking: "",
      options: {
        ...GLASS_HEADER_OPTIONS,
        contentStyle: { backgroundColor: "transparent" },
        headerBackVisible: false,
        ...getCompactBrandHeaderOptions(),
      },
    }),
    Thread: createNativeStackScreen({
      screen: ThreadRouteScreen,
      linking: THREAD_LINKING_PREFIX,
      options: GLASS_HEADER_OPTIONS,
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
      },
    }),
    ThreadReview: createNativeStackScreen({
      screen: ReviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/review`,
      options: SOLID_HEADER_OPTIONS,
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
      options: SOLID_HEADER_OPTIONS,
    }),
    ThreadAttachment: createNativeStackScreen({
      screen: AttachmentFileScreen,
      linking: `${THREAD_LINKING_PREFIX}/attachments/:attachmentId`,
      options: SOLID_HEADER_OPTIONS,
    }),
    // Deliberately the one root route with no `linking:` path. The route
    // carries zero params: its content is a session object (staged model,
    // provider groups, and live update callbacks) that the active
    // ThreadComposer presents into ExistingThreadSettingsRouteProvider before
    // pushing this screen — state no URL can reconstruct. Reached without a
    // presented session the screen navigates straight back, so a path would
    // only produce a flash-and-dismiss link. Deep links to a thread land on
    // `threads/:environmentId/:threadId`, where this sheet is one tap away.
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
    GitOverview: createNativeStackScreen({
      screen: GitOverviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/git`,
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
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.55, 0.92],
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
      linking: "settings",
      options: {
        gestureEnabled: true,
        headerShown: false,
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
        // Android: full page; the screen renders its own AndroidScreenHeader,
        // so the native bar stays hidden. iOS keeps the sheet.
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
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.55, 0.7],
        sheetGrabberVisible: true,
      },
    }),
    NewTaskSheet: createNativeStackScreen({
      screen: NewTaskSheetStack,
      linking: "new",
      // The whole new-task flow (choose project → draft → add project) shares
      // draft state via NewTaskFlowProvider. The expo-router era mounted it in
      // app/new/_layout.tsx; this layout wrapper is the native-stack equivalent.
      // A screen's layout replaces the navigator's screenLayout.
      layout: ({ children, route }) => (
        <GuardedScreenLayout route={route}>
          <NewTaskFlowProvider>
            <View className="flex-1 bg-sheet-solid">{children}</View>
          </NewTaskFlowProvider>
        </GuardedScreenLayout>
      ),
      options: {
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
  const usesWorkspaceFlowScreens =
    Platform.OS === "android" || deriveLayout({ width, height }).usesSplitView;

  return (
    <Navigator
      screenLayout={GuardedScreenLayout}
      screenOptions={({ route }) => {
        if (route.name !== "SettingsSheet" && route.name !== "NewTaskSheet") {
          return {};
        }

        // Follow the workspace viewport as it resizes; compact iOS keeps sheets.
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
