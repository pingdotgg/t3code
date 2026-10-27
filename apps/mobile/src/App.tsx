import { installPermissionUpdateNotice } from "./features/connection/permissionUpdateNotice";
import { installComposerAttachmentUploads } from "./state/composer-attachment-uploads";
import { installThreadOutboxDelivery } from "./state/threadOutboxDelivery";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  CommonActions,
  createPathConfigForStaticNavigation,
  createStaticNavigation,
  getActionFromState,
  getStateFromPath,
  type NavigationAction,
  type NavigationState,
} from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
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
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";
import { OverlayPortalHost } from "./components/ui/OverlayPortal";
import { shouldHandleAppLink, restoreDraftLinkState } from "./lib/appLinking";
import { hasCloudPublicConfig } from "./features/cloud/publicConfig";
import { takeScheduledTaskNewLink } from "./features/settings/scheduled-task-editor-state";
import { pairingFormLinkAction, startDevAutoConnect } from "./features/connection/devAutoConnect";
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
} from "./features/workspace/workspace-selection-store";
import { workspaceDetailLinkAction } from "./features/workspace/workspace-detail-selection";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";
import {
  attachRootNavigation,
  flushRootNavigationQueue,
  linkToRootPath,
  rootNavigationRef,
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
  return takeScheduledTaskNewLink(
    startDevAutoConnect(
      takeNewTaskPromptLink(
        takeThreadPromptLink(
          restoreSettingsLinkState(
            restoreDraftLinkState(getStateFromPath(path, options), path),
            settingsLinkPage(),
          ),
        ),
      ),
    ),
  );
}

const appLinking = {
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  config: { initialRouteName: "Home" },
  filter: (url: string) => shouldHandleAppLink(url, hasCloudPublicConfig()),
  getInitialURL: async () => (await Linking.getInitialURL()) ?? (await launchWorkspaceURL()),
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

const Navigation = createStaticNavigation(RootStack);

function handleNavigationStateChange(state: NavigationState | undefined): void {
  recordWorkspaceSelections(state);
  presentPendingIncomingShare();
  resolvePendingNewTaskPromptLink(state);
  resolvePendingThreadPromptLink(state);
  if (!state) return;
  setAgentNotificationPathname(workspaceLocationFromState(state).pathname);
  recordAppShortcutNavigationState(state);
  pruneNewTaskFlowStates(state);
  pruneNewTaskBranchCheckouts(state);
  pruneIncomingShareImports(state);
}

function handleNavigationReady(): void {
  handleNavigationStateChange(rootNavigationRef.getRootState());
  flushRootNavigationQueue();
}

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const appServiceDisposers = [
  installUiRuntimeMemoryWarningGc(),
  subscribeComposerDraftModelReconciliation({
    registry: appAtomRegistry,
    threadShellAtom: environmentThreadShells.threadShellAtom,
    threadRefsAtom: environmentThreadShells.threadRefsAtom,
    shellStateAtom: environmentShell.stateAtom,
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
];
disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () => {
  for (const dispose of appServiceDisposers) dispose();
});

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the native splash screen once appearance preferences have loaded
  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

  return null;
}

export default function App() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <AppContent />
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();

  return (
    <>
      <SplashScreenCoordinator />
      <SubscriptionUsageCoordinator />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
            {/* native-stack needs the theme's dark flag to select dark native headers. */}
            <GlobalVoiceInputControl>
              <NativeLayoutMetricsProvider>
                <Navigation
                  ref={attachRootNavigation}
                  linking={appLinking}
                  onReady={handleNavigationReady}
                  theme={navigationTheme}
                  onStateChange={handleNavigationStateChange}
                />
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
