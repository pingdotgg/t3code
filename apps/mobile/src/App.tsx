import { installPermissionUpdateNotice } from "./features/connection/permissionUpdateNotice";
import { installComposerAttachmentUploads } from "./state/composer-attachment-uploads";
import { installThreadOutboxDelivery } from "./state/threadOutboxDelivery";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { requireNativeModule, requireOptionalNativeModule } from "expo";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  CommonActions,
  createPathConfigForStaticNavigation,
  createStaticNavigation,
  getActionFromState,
  getStateFromPath,
  NavigationIndependentTree,
  type NavigationAction,
  type NavigationContainerRef,
} from "@react-navigation/native";
import { pipe } from "effect/Function";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ProjectChipIconRasterizer } from "./native/ProjectChipIconImages";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import * as Dialog from "./components/ui/Dialog";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { installShowcaseCapture } from "./features/showcase/ShowcaseCaptureCoordinator";
import {
  presentPendingIncomingShare,
  pruneIncomingShareImports,
  startIncomingShareInbox,
} from "./features/sharing/IncomingShareProvider";
import {
  installAgentNotificationNavigation,
  setAgentNotificationPathname,
} from "./features/agent-awareness/notificationNavigation";
import {
  installAppShortcuts,
  recordAppShortcutNavigationState,
} from "./features/shortcuts/appShortcutsRuntime";
import {
  AppearancePreferencesProvider,
  installAppearanceRuntime,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack, rootPathnameFromState, workspaceLocationFromState } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { subscribeComposerDraftModelReconciliation } from "./state/use-composer-drafts";
import { environmentThreadShells, threadEnvironment } from "./state/threads";
import { environmentShell, shellCachesReadAtom } from "./state/shell";
import { OverlayPortalHost } from "./components/ui/OverlayPortal";
import { shouldHandleAppLink, restoreDraftLinkState } from "./lib/appLinking";
import { hasCloudPublicConfig } from "./features/cloud/publicConfig";
import { takeScheduledTaskNewLink } from "./features/settings/scheduled-task-editor-state";
import {
  pairingFormLinkAction,
  startDevAutoConnect,
  withoutPairingTarget,
} from "./features/connection/devAutoConnect";
import {
  resolvePendingNewTaskPromptLink,
  takeNewTaskPromptLink,
} from "./features/prompt-links/newTaskPromptLink";
import {
  resolvePendingThreadPromptLink,
  takeThreadPromptLink,
} from "./features/prompt-links/threadPromptLink";
import {
  disposeOnFoundationReplace,
  type FoundationHotModule,
} from "./lib/foundation-fast-refresh";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { installUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { installSubscriptionUsageRefresh } from "./widgets/useSubscriptionUsage";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import { restoreSettingsLinkState } from "./features/settings/settings-navigation";
import {
  hydrateWorkspaceSelections,
  launchWorkspaceURL,
  recordWorkspaceSelections,
  settingsLinkPage,
} from "./features/layout/workspace/workspace-selection-store";
import { workspaceDetailLinkAction } from "./features/layout/workspace/workspace-detail-selection";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";
import { NativeWindowObserver } from "./native/NativeWindowObserver";
import {
  activateAppWindow,
  allocateAppWindowId,
  AppWindowContext,
  closeAppWindow,
  subscribeAppWindows,
  useAppWindowId,
  type AppWindowId,
} from "./lib/appWindows";
import {
  attachRootNavigation,
  flushRootNavigationQueue,
  rootNavigationWindowStatus,
  linkToRootPath,
  rootNavigationRef,
  rootNavigationRoutes,
} from "./lib/rootNavigation";
import { pruneNewTaskFlowStates } from "./features/threads/new-task-flow-state";
import { pruneNewTaskBranchCheckouts } from "./features/threads/NewTaskDraftRouteScreen";
import { installAppUpdateChecks } from "./features/updates/app-updates";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {});
void hydrateWorkspaceSelections();

const linkingConfig = {
  initialRouteName: "Home",
  screens: createPathConfigForStaticNavigation(RootStack, { initialRouteName: "Home" }) ?? {},
} as const;

function getAppStateFromPath(path: string, options: Parameters<typeof getStateFromPath>[1]) {
  return pipe(
    getStateFromPath(path, options),
    (state) => restoreDraftLinkState(state, path),
    (state) => restoreSettingsLinkState(state, settingsLinkPage()),
    takeThreadPromptLink,
    takeNewTaskPromptLink,
    withoutPairingTarget,
    startDevAutoConnect,
    takeScheduledTaskNewLink,
  );
}

// A link that launched the app opens in its first window. A window opened later starts where the
// app remembers; Android's replacement activity still reads the link that started it.
let launchLinkTaken = false;

async function initialWindowURL(windowId: AppWindowId) {
  const readsLaunchLink = !launchLinkTaken || Platform.OS !== "ios";
  launchLinkTaken = true;
  return (
    (readsLaunchLink ? await Linking.getInitialURL() : null) ?? (await launchWorkspaceURL(windowId))
  );
}

const appLinking = {
  prefixes: [
    Linking.createURL("/"),
    "t3code://",
    "t3code-dev://",
    "t3code-preview://",
    DEFAULT_HOSTED_APP_URL,
  ],
  config: { initialRouteName: "Home" },
  filter: (url: string) => shouldHandleAppLink(url, hasCloudPublicConfig()),
  getActionFromState: (
    state: Parameters<typeof getActionFromState>[0],
    options: Parameters<typeof getActionFromState>[1],
  ): ReturnType<typeof getActionFromState> =>
    // Our router handles the selection; React Navigation's type only lists its own actions.
    (workspaceDetailLinkAction(state) as ReturnType<typeof getActionFromState>) ??
    pairingFormLinkAction(
      state,
      rootNavigationRef.isReady() ? rootNavigationRef.getRootState() : undefined,
    ) ??
    getActionFromState(state, options),
  getStateFromPath: getAppStateFromPath,
};

function appLinkAction(href: string): NavigationAction {
  const state = getAppStateFromPath(href, linkingConfig);
  if (!state) throw new Error(`Failed to parse the href to a navigation state (${href}).`);
  return appLinking.getActionFromState(state, linkingConfig) ?? CommonActions.reset(state);
}

function linkToAppPath(href: string): void {
  linkToRootPath(href, appLinkAction);
}

/** Every window's container hears an opened link; it belongs to the window in use. */
function windowLinking(windowId: AppWindowId) {
  return {
    ...appLinking,
    getInitialURL: () => initialWindowURL(windowId),
    subscribe: (listener: (url: string) => void) => {
      const subscription = Linking.addEventListener("url", ({ url }) => {
        if (rootNavigationWindowStatus(windowId) === "current") listener(url);
      });
      return () => subscription.remove();
    },
  };
}

const Navigation = createStaticNavigation(RootStack);

/**
 * Runs when any window navigates and when another window comes into use. The app's services
 * follow the window in use, so they read its state whichever window changed.
 */
function handleNavigationStateChange(): void {
  // A window that is still mounting reports once its container is ready.
  if (!rootNavigationRef.isReady()) return;
  const state = rootNavigationRef.getRootState();
  recordWorkspaceSelections(state);
  presentPendingIncomingShare();
  resolvePendingNewTaskPromptLink(state);
  resolvePendingThreadPromptLink(state);
  if (!state) return;
  setAgentNotificationPathname(workspaceLocationFromState(state).pathname);
  recordAppShortcutNavigationState(state);
  // A draft is live while any window still has its route.
  const routes = rootNavigationRoutes();
  pruneNewTaskFlowStates(routes);
  pruneNewTaskBranchCheckouts(routes);
  pruneIncomingShareImports(routes);
}

function handleNavigationReady(): void {
  handleNavigationStateChange();
  flushRootNavigationQueue();
}

const nativeControls = requireOptionalNativeModule<{
  readonly revealWindows?: () => Promise<void>;
}>("T3NativeControls");

function hideSplashScreen(): void {
  void SplashScreen.hide();
  // expo-splash-screen hides the launch screen of the newest window only. Native code counts the
  // windows: another one can be connected before its root has registered here.
  void nativeControls?.revealWindows?.().catch(() => undefined);
}

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const appServiceDisposers = [
  installUiRuntimeMemoryWarningGc(),
  subscribeComposerDraftModelReconciliation({
    registry: appAtomRegistry,
    threadShellAtom: environmentThreadShells.threadShellAtom,
    threadRefsAtom: environmentThreadShells.threadRefsAtom,
    shellStateAtom: environmentShell.stateAtom,
    pendingThreadIdsAtom: threadEnvironment.pendingThreadIdsAtom,
  }),
  installAppearanceRuntime(),
  installSubscriptionUsageRefresh(),
  installPermissionUpdateNotice(),
  installThreadOutboxDelivery(),
  installComposerAttachmentUploads(),
  startIncomingShareInbox(),
  installAgentNotificationNavigation(linkToAppPath),
  installAppShortcuts(linkToAppPath),
  installAppUpdateChecks(),
  installShowcaseCapture(rootPathnameFromState),
  subscribeAppWindows(handleNavigationStateChange),
];
disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () => {
  for (const dispose of appServiceDisposers) dispose();
});

// Cached shells are local reads that end in a fraction of this time; the limit only keeps a
// failed read from holding the splash screen.
const SPLASH_SHELL_CACHE_WAIT_MS = 1_500;

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();
  const shellCachesRead = useAtomValue(shellCachesReadAtom);
  const [waitEnded, setWaitEnded] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the limit on how long the native splash screen waits for cached shells
  useEffect(() => {
    const timer = setTimeout(() => setWaitEnded(true), SPLASH_SHELL_CACHE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  // The thread list paints every environment's cached rows at once when the splash hides
  // after they are read.
  const canHide = isReady && (shellCachesRead || waitEnded);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the native splash screen once preferences and cached shells have loaded
  useEffect(() => {
    if (canHide) hideSplashScreen();
  }, [canHide]);

  return null;
}

// iOS mounts this once per window, on one JS runtime: see lib/appWindows.
export default function App() {
  const [windowId] = useState(allocateAppWindowId);
  return (
    <AppWindowContext value={windowId}>
      <RegistryContext.Provider value={appAtomRegistry}>
        <CloudAuthProvider>
          <AppearancePreferencesProvider>
            <AppContent />
          </AppearancePreferencesProvider>
        </CloudAuthProvider>
      </RegistryContext.Provider>
    </AppWindowContext>
  );
}

function AppContent() {
  const windowId = useAppWindowId();
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();
  const linking = useMemo(() => windowLinking(windowId), [windowId]);
  const attachNavigation = useCallback(
    (navigation: NavigationContainerRef<ReactNavigation.RootParamList> | null) =>
      attachRootNavigation(windowId, navigation),
    [windowId],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this root's window with the store the app's services read outside React; a new window opens in use
  useEffect(() => {
    activateAppWindow(windowId);
    return () => closeAppWindow(windowId);
  }, [windowId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- matches the Android navigation bar to the app theme, as StatusBar does for the status bar
  useEffect(() => {
    if (Platform.OS !== "android") return;
    void requireNativeModule<{ setNavigationBarStyle(light: boolean): Promise<void> }>(
      "T3NativeControls",
    ).setNavigationBarStyle(themeAppearance === "light");
  }, [themeAppearance]);

  return (
    <>
      <SplashScreenCoordinator />
      <NativeWindowObserver
        onChange={(state) =>
          state === "active" ? activateAppWindow(windowId) : closeAppWindow(windowId)
        }
      />
      <SubscriptionUsageCoordinator />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
            {/* native-stack needs the theme's dark flag to select dark native headers. */}
            <GlobalVoiceInputControl>
              <NativeLayoutMetricsProvider>
                {/* Each window's root has a container; they are not nested, and each handles links. */}
                <NavigationIndependentTree>
                  <Navigation
                    ref={attachNavigation}
                    linking={linking}
                    onReady={handleNavigationReady}
                    theme={navigationTheme}
                    onStateChange={handleNavigationStateChange}
                  />
                </NavigationIndependentTree>
                <Dialog.Host />
                <ThreadArrangementHost />
                <ProjectChipIconRasterizer />
              </NativeLayoutMetricsProvider>
            </GlobalVoiceInputControl>
            <OverlayPortalHost />
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
