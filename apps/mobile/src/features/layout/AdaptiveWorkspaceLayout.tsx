import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  CommonActions,
  NavigationContext,
  NavigationRouteContext,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform, useWindowDimensions, View } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AsyncResult } from "effect/reactivity";

import {
  deriveFileInspectorPaneLayout,
  deriveLayout,
  deriveWorkspacePaneLayout,
  type FileInspectorPaneLayout,
  type Layout,
  type WorkspaceAuxiliaryPaneRole,
  type WorkspacePaneLayout,
} from "../../lib/layout";
import {
  resolveThreadSelectionNavigationAction,
  resolveThreadSelectionOverlayState,
} from "../../lib/adaptive-navigation";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type { ThreadListFilters } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping";
import {
  parseActiveThreadPath,
  useHardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { AndroidHomeFabLayout } from "../home/AndroidHomeFab";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import {
  AndroidWorkspaceNavigation,
  ANDROID_WORKSPACE_RAIL_WIDTH,
} from "../workspace/AndroidWorkspaceNavigation";
import { AndroidWorkspaceSidebar } from "../workspace/AndroidWorkspaceSidebar";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
import { HomeListOptionsProvider } from "../home/home-list-options";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspaceInspectorPane } from "./workspace-inspector-pane";
import { WorkspaceContentWidthContext } from "./workspace-content-width";
import {
  NativeWorkspaceModeContext,
  NativeWorkspaceInspectorContext,
} from "../../native/v5-workspace-context";

import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";

interface AdaptiveWorkspaceContextValue {
  readonly layout: Layout;
  readonly panes: WorkspacePaneLayout;
  readonly fileInspector: FileInspectorPaneLayout;
  readonly primarySidebarSearchQuery: string;
  readonly selectThread: (thread: EnvironmentThreadShell) => void;
  readonly activateAuxiliaryPaneRole: (role: WorkspaceAuxiliaryPaneRole) => () => void;
  readonly registerWorkspaceInspector: (render: () => ReactNode) => () => void;
  readonly setPrimarySidebarSearchQuery: (query: string) => void;
  readonly showAuxiliaryPane: (role: WorkspaceAuxiliaryPaneRole) => void;
  readonly toggleAuxiliaryPane: () => void;
  readonly togglePrimarySidebar: () => void;
  readonly setAuxiliaryPaneWidth: (width: number) => void;
}

const compactLayout = deriveLayout({ width: 0, height: 0 });
const compactPanes = deriveWorkspacePaneLayout({
  layout: compactLayout,
  viewportWidth: 0,
  primarySidebarPreferredVisible: true,
  auxiliaryPanePreferredVisible: true,
});
const compactFileInspector = deriveFileInspectorPaneLayout({
  layout: compactLayout,
  viewportWidth: 0,
});
const AdaptiveWorkspaceContext = createContext<AdaptiveWorkspaceContextValue>({
  layout: compactLayout,
  panes: compactPanes,
  fileInspector: compactFileInspector,
  primarySidebarSearchQuery: "",
  selectThread: () => undefined,
  activateAuxiliaryPaneRole: () => () => undefined,
  registerWorkspaceInspector: () => () => undefined,
  setPrimarySidebarSearchQuery: () => undefined,
  showAuxiliaryPane: () => undefined,
  toggleAuxiliaryPane: () => undefined,
  togglePrimarySidebar: () => undefined,
  setAuxiliaryPaneWidth: () => undefined,
});

export function useAdaptiveWorkspaceLayout(): AdaptiveWorkspaceContextValue {
  return use(AdaptiveWorkspaceContext);
}

export function useAdaptiveWorkspacePaneRole(role: WorkspaceAuxiliaryPaneRole) {
  const { activateAuxiliaryPaneRole } = useAdaptiveWorkspaceLayout();

  useFocusEffect(
    useCallback(() => activateAuxiliaryPaneRole(role), [activateAuxiliaryPaneRole, role]),
  );
}

/**
 * The column renders BESIDE the navigator — outside any screen — so the
 * registering screen's navigation and route contexts are captured here and
 * re-provided around the portal content.
 *
 * Registration is FOCUS-scoped, driven by navigation events rather than the
 * screen's own render cycle: react-native-screens freezes blurred screens, so a
 * cleanup that depends on the blurred subtree re-rendering never runs and would
 * leak the pane into the next route.
 */
export function useRegisterWorkspaceInspector(render: (() => ReactNode) | undefined) {
  const { registerWorkspaceInspector } = useAdaptiveWorkspaceLayout();
  const navigation = use(NavigationContext);
  const route = use(NavigationRouteContext);

  const wrappedRender = useMemo(() => {
    if (render === undefined) {
      return undefined;
    }
    return () => (
      <NavigationContext.Provider value={navigation}>
        <NavigationRouteContext.Provider value={route}>{render()}</NavigationRouteContext.Provider>
      </NavigationContext.Provider>
    );
  }, [navigation, render, route]);

  const wrappedRenderRef = useRef(wrappedRender);
  wrappedRenderRef.current = wrappedRender;
  const focusedRef = useRef(false);
  const deactivateRef = useRef<(() => void) | null>(null);

  const syncRegistration = useCallback(() => {
    if (!focusedRef.current || wrappedRenderRef.current === undefined) {
      deactivateRef.current?.();
      return;
    }
    deactivateRef.current = registerWorkspaceInspector(wrappedRenderRef.current);
  }, [registerWorkspaceInspector]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      syncRegistration();
      return () => {
        focusedRef.current = false;
        syncRegistration();
      };
    }, [syncRegistration]),
  );

  useEffect(() => {
    if (focusedRef.current) {
      syncRegistration();
    }
  }, [syncRegistration, wrappedRender]);

  useEffect(
    () => () => {
      deactivateRef.current?.();
      deactivateRef.current = null;
    },
    [],
  );
}

export function AdaptiveWorkspaceLayout(props: {
  readonly children: ReactNode;
  readonly pathname: string;
  readonly workspaceRouteKey: string | undefined;
  readonly selectedPullRequestKey?: string | null;
}) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferencesResult)) {
    return AsyncResult.isFailure(preferencesResult) ? (
      <AdaptiveWorkspaceLayoutContent
        {...props}
        projectGroupingMode={DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS.sidebarProjectGroupingMode}
      />
    ) : null;
  }
  const groupingSettings = resolveMobileProjectGroupingSettings(preferencesResult.value);
  return (
    <AdaptiveWorkspaceLayoutContent
      {...props}
      projectGroupingMode={groupingSettings.sidebarProjectGroupingMode}
      savedThreadListFilters={preferencesResult.value.threadListFilters}
    />
  );
}

function AdaptiveWorkspaceLayoutContent(
  props: {
    readonly children: ReactNode;
    readonly pathname: string;
    readonly workspaceRouteKey: string | undefined;
    readonly selectedPullRequestKey?: string | null;
  } & {
    readonly projectGroupingMode: SidebarProjectGroupingMode;
    readonly savedThreadListFilters?: ThreadListFilters | undefined;
  },
) {
  const projectGroupingMode = props.projectGroupingMode;
  const nativeWorkspace = use(NativeWorkspaceModeContext);
  const windowDimensions = useWindowDimensions();
  const nativeMetrics = useNativeLayoutMetrics();
  const { width: viewportWidth, height } = nativeMetrics ?? windowDimensions;
  const { scale: androidControlScale } = useAndroidControlSizing();
  const pathname = props.pathname;
  const navigation = useNavigation();
  const activeRoleOwner = useRef<symbol | null>(null);
  const [primarySidebarPreferredVisible, setPrimarySidebarPreferredVisible] = useState(true);
  const showPrimarySidebar = pathname === "/" || primarySidebarPreferredVisible;
  const [supplementaryPanePreferredVisible, setSupplementaryPanePreferredVisible] = useState(true);
  const [supplementaryPanePreferredWidth, setSupplementaryPanePreferredWidth] = useState<
    number | null
  >(null);
  const [fileInspectorPreferredVisible, setFileInspectorPreferredVisible] = useState(true);
  const [fileInspectorPreferredWidth, setFileInspectorPreferredWidth] = useState<number | null>(
    null,
  );
  const [primarySidebarSearchQuery, setPrimarySidebarSearchQuery] = useState("");
  const [focusedAuxiliaryPaneRole, setFocusedAuxiliaryPaneRole] =
    useState<WorkspaceAuxiliaryPaneRole | null>(null);
  const baseLayout = useMemo(
    () => deriveLayout({ width: viewportWidth, height, nativeMetrics }),
    [height, viewportWidth, nativeMetrics],
  );
  const layout = baseLayout;
  const shouldRenderNavigationRail = Platform.OS === "android" && layout.usesSplitView;
  const navigationRailWidth =
    shouldRenderNavigationRail && showPrimarySidebar
      ? ANDROID_WORKSPACE_RAIL_WIDTH * Math.max(1, androidControlScale)
      : 0;
  const width = viewportWidth - navigationRailWidth;
  const shouldRenderPrimarySidebar = layout.usesSplitView;
  const fileInspector = useMemo(
    () =>
      deriveFileInspectorPaneLayout({
        layout,
        viewportWidth: width,
        preferredWidth: fileInspectorPreferredWidth ?? undefined,
        reservedLeadingWidth:
          shouldRenderPrimarySidebar && showPrimarySidebar
            ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0)
            : 0,
      }),
    [fileInspectorPreferredWidth, layout, showPrimarySidebar, shouldRenderPrimarySidebar, width],
  );
  const auxiliaryPaneRole: WorkspaceAuxiliaryPaneRole =
    focusedAuxiliaryPaneRole ?? (/\/files(?:\/|$)/.test(pathname) ? "inspector" : "supplementary");
  const auxiliaryPanePreferredVisible =
    auxiliaryPaneRole === "inspector"
      ? fileInspectorPreferredVisible
      : supplementaryPanePreferredVisible;
  const auxiliaryPanePreferredWidth =
    auxiliaryPaneRole === "inspector"
      ? fileInspectorPreferredWidth
      : supplementaryPanePreferredWidth;
  const panes = useMemo(
    () =>
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: width,
        primarySidebarPreferredVisible: showPrimarySidebar,
        auxiliaryPanePreferredVisible,
        auxiliaryPaneRole,
        auxiliaryPanePreferredWidth: auxiliaryPanePreferredWidth ?? undefined,
      }),
    [
      auxiliaryPanePreferredVisible,
      auxiliaryPaneRole,
      auxiliaryPanePreferredWidth,
      layout,
      showPrimarySidebar,
      width,
    ],
  );
  const activeThread = parseActiveThreadPath(pathname);
  const environmentId = activeThread?.environmentId ?? null;
  const threadId = activeThread?.threadId ?? null;
  const selectedThreadKey = useMemo(() => {
    if (environmentId === null || threadId === null) {
      return null;
    }
    try {
      return scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(threadId));
    } catch {
      return null;
    }
  }, [environmentId, threadId]);
  const [workspaceInspector, setWorkspaceInspector] = useState<{
    readonly render: () => ReactNode;
    readonly active: boolean;
  } | null>(null);
  const workspaceInspectorOwner = useRef<symbol | null>(null);
  const registerWorkspaceInspector = useCallback((render: () => ReactNode) => {
    const owner = Symbol("workspace-inspector");
    workspaceInspectorOwner.current = owner;
    setWorkspaceInspector({ render, active: true });

    return () => {
      // During a push/replace the outgoing screen deactivates AFTER the
      // incoming screen registered — only the current owner may deactivate.
      if (workspaceInspectorOwner.current !== owner) {
        return;
      }
      setWorkspaceInspector((current) => (current === null ? null : { ...current, active: false }));
    };
  }, []);
  const handleWorkspaceInspectorClosed = useCallback(() => {
    setWorkspaceInspector((current) => (current !== null && !current.active ? null : current));
  }, []);
  const activateAuxiliaryPaneRole = useCallback((role: WorkspaceAuxiliaryPaneRole) => {
    const owner = Symbol(role);
    activeRoleOwner.current = owner;
    setFocusedAuxiliaryPaneRole(role);

    return () => {
      if (activeRoleOwner.current !== owner) {
        return;
      }
      activeRoleOwner.current = null;
      setFocusedAuxiliaryPaneRole(null);
    };
  }, []);
  const togglePrimarySidebar = useCallback(() => {
    if (pathname === "/") {
      return;
    }
    if (!panes.primarySidebarVisible && panes.primarySidebarSuppressedByAuxiliary) {
      setFileInspectorPreferredVisible(false);
      setPrimarySidebarPreferredVisible(true);
      return;
    }
    setPrimarySidebarPreferredVisible((current) => !current);
  }, [panes.primarySidebarSuppressedByAuxiliary, panes.primarySidebarVisible, pathname]);
  const revealPrimarySidebar = useCallback(() => {
    if (panes.primarySidebarSuppressedByAuxiliary) {
      setFileInspectorPreferredVisible(false);
    }
    setPrimarySidebarPreferredVisible(true);
  }, [panes.primarySidebarSuppressedByAuxiliary]);
  const handleToggleSidebarCommand = useCallback(() => {
    togglePrimarySidebar();
    return true;
  }, [togglePrimarySidebar]);
  const sidebarCommands = useMemo(
    () => (pathname === "/" ? [] : (["toggleSidebar"] as const)),
    [pathname],
  );
  useHardwareKeyboardCommand(sidebarCommands, handleToggleSidebarCommand);
  const showAuxiliaryPane = useCallback((role: WorkspaceAuxiliaryPaneRole) => {
    if (role === "inspector") {
      setFocusedAuxiliaryPaneRole("inspector");
      setFileInspectorPreferredVisible(true);
      return;
    }
    setFocusedAuxiliaryPaneRole("supplementary");
    setSupplementaryPanePreferredVisible(true);
  }, []);
  const handleOpenFilesCommand = useCallback(() => {
    const activeThread = parseActiveThreadPath(pathname);
    if (!layout.usesSplitView || !fileInspector.supported || activeThread === null) {
      return false;
    }
    showAuxiliaryPane("inspector");
    if (/\/files(?:\/|$)/.test(pathname)) {
      return true;
    }
    navigation.navigate("ThreadFiles", activeThread);
    return true;
  }, [fileInspector.supported, layout.usesSplitView, pathname, navigation, showAuxiliaryPane]);
  useHardwareKeyboardCommand("files", handleOpenFilesCommand);
  const toggleAuxiliaryPane = useCallback(() => {
    if (auxiliaryPaneRole === "inspector") {
      setFileInspectorPreferredVisible((current) => !current);
      return;
    }
    setSupplementaryPanePreferredVisible((current) => !current);
  }, [auxiliaryPaneRole]);
  const setAuxiliaryPaneWidth = useCallback(
    (nextWidth: number) => {
      if (auxiliaryPaneRole === "inspector") {
        setFileInspectorPreferredWidth(nextWidth);
        return;
      }
      setSupplementaryPanePreferredWidth(nextWidth);
    },
    [auxiliaryPaneRole],
  );
  const handleOpenSettings = useCallback(() => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "Settings" },
    });
  }, [navigation]);

  const handleStartNewTask = useCallback(() => {
    navigation.navigate("NewTaskSheet", { screen: "NewTask" });
  }, [navigation]);

  // Minted here (root stack navigation) so the sidebar pane stays free of
  // navigation hooks — on iOS it renders inside an independent nav tree.
  const handleOpenEnvironmentSettings = useCallback(() => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsEnvironments" },
    });
  }, [navigation]);

  const handleNewThreadOnBranch = useCallback(
    (thread: EnvironmentThreadShell) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(thread.environmentId),
          projectId: String(thread.projectId),
          environmentSelection: "manual",
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      });
    },
    [navigation],
  );

  const handleNewThreadInProject = useCallback(
    (project: EnvironmentProject) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          title: project.title,
        },
      });
    },
    [navigation],
  );

  const inspectorColumnTargetWidth =
    workspaceInspector !== null && workspaceInspector.active && panes.auxiliaryPaneVisible
      ? (panes.auxiliaryPaneWidth ?? 0)
      : 0;
  const contentTargetWidth = layout.usesSplitView
    ? Math.max(0, panes.contentPaneWidth - inspectorColumnTargetWidth)
    : null;
  const [contentSizing, setContentSizing] = useState({
    viewportWidth,
    target: contentTargetWidth,
    sidebarVisible: panes.primarySidebarVisible,
    width: contentTargetWidth,
    revision: 0,
  });
  if (
    Platform.OS === "android" &&
    (contentSizing.viewportWidth !== viewportWidth ||
      contentSizing.target !== contentTargetWidth ||
      contentSizing.sidebarVisible !== panes.primarySidebarVisible)
  ) {
    const openingSidebar =
      Platform.OS === "android" &&
      contentSizing.viewportWidth === viewportWidth &&
      !contentSizing.sidebarVisible &&
      panes.primarySidebarVisible &&
      contentSizing.width !== null &&
      contentTargetWidth !== null;
    setContentSizing({
      viewportWidth,
      target: contentTargetWidth,
      sidebarVisible: panes.primarySidebarVisible,
      width: openingSidebar
        ? Math.max(contentSizing.width ?? 0, contentTargetWidth ?? 0)
        : contentTargetWidth,
      revision: contentSizing.revision + 1,
    });
  }
  const settleContentWidth = useCallback((revision: number) => {
    setContentSizing((current) =>
      current.revision !== revision || current.width === current.target
        ? current
        : { ...current, width: current.target },
    );
  }, []);
  const contentSettledWidth = Platform.OS === "android" ? contentSizing.width : contentTargetWidth;
  const contentRevision = contentSizing.revision;

  const renderedSidebarWidth = useSharedValue(
    panes.primarySidebarVisible ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0) : 0,
  );
  const renderedRailWidth = useSharedValue(navigationRailWidth);
  useEffect(() => {
    if (nativeWorkspace) return;
    const targetWidth = panes.primarySidebarVisible
      ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0)
      : 0;
    renderedSidebarWidth.value = withTiming(targetWidth, WORKSPACE_PANE_TIMING, (finished) => {
      if (finished && Platform.OS === "android") runOnJS(settleContentWidth)(contentRevision);
    });
    renderedRailWidth.set(withTiming(navigationRailWidth, WORKSPACE_PANE_TIMING));
  }, [
    nativeWorkspace,
    navigationRailWidth,
    layout.listPaneWidth,
    layout.listPaneGap,
    panes.primarySidebarVisible,
    renderedSidebarWidth,
    renderedRailWidth,
    settleContentWidth,
    contentRevision,
  ]);
  const railAnimatedStyle = useAnimatedStyle(() => ({ width: renderedRailWidth.value }));
  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    // Fading a UIKit glass ancestor can leave remounted header effects missing.
    opacity: Platform.OS === "ios" ? 1 : Math.min(1, renderedSidebarWidth.value / 80),
    width: renderedSidebarWidth.value,
  }));

  // The navigator (native header + markdown feed) lays out ONCE per pane toggle
  // instead of re-measuring on every animation frame — the animating columns
  // merely clip/reveal it over a matching background.
  const renderedInspectorWidth = useSharedValue(inspectorColumnTargetWidth);
  const renderedContentWidth = useDerivedValue(() =>
    Math.max(
      0,
      viewportWidth -
        renderedRailWidth.value -
        renderedSidebarWidth.value -
        renderedInspectorWidth.value,
    ),
  );

  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      const params = {
        environmentId: String(thread.environmentId),
        threadId: String(thread.id),
      };
      if (Platform.OS === "android") {
        setFileInspectorPreferredVisible(false);
        selectAndroidWorkspace({ name: "Thread", params });
        return;
      }
      const navigationAction = resolveThreadSelectionNavigationAction({
        usesSplitView: layout.usesSplitView,
        pathname,
      });
      const overlayState = resolveThreadSelectionOverlayState({
        state: navigation.getState(),
        workspaceRouteKey: props.workspaceRouteKey,
        action: navigationAction,
        params,
      });
      if (overlayState !== null) {
        setFileInspectorPreferredVisible(false);
        navigation.dispatch(CommonActions.reset(overlayState));
        return;
      }
      if (navigationAction === "set-params") {
        const nextThreadKey = scopedThreadKey(thread.environmentId, thread.id);
        if (nextThreadKey === selectedThreadKey) {
          return;
        }
        setFileInspectorPreferredVisible(false);
        navigation.navigate("Thread", params);
        return;
      }
      if (navigationAction === "replace") {
        setFileInspectorPreferredVisible(false);
        navigation.dispatch(StackActions.replace("Thread", params));
        return;
      }
      navigation.navigate("Thread", params);
    },
    [
      layout.usesSplitView,
      pathname,
      navigation,
      selectedThreadKey,
      props.workspaceRouteKey,
      selectAndroidWorkspace,
    ],
  );

  const contextValue = useMemo(
    () => ({
      layout,
      panes,
      fileInspector,
      primarySidebarSearchQuery,
      selectThread: handleSelectThread,
      activateAuxiliaryPaneRole,
      registerWorkspaceInspector,
      setPrimarySidebarSearchQuery,
      showAuxiliaryPane,
      toggleAuxiliaryPane,
      togglePrimarySidebar,
      setAuxiliaryPaneWidth,
    }),
    [
      activateAuxiliaryPaneRole,
      fileInspector,
      handleSelectThread,
      layout,
      panes,
      primarySidebarSearchQuery,
      registerWorkspaceInspector,
      showAuxiliaryPane,
      setPrimarySidebarSearchQuery,
      setAuxiliaryPaneWidth,
      toggleAuxiliaryPane,
      togglePrimarySidebar,
    ],
  );

  if (nativeWorkspace) {
    return (
      <HomeListOptionsProvider
        projectGroupingMode={projectGroupingMode}
        savedFilters={props.savedThreadListFilters}
      >
        <AdaptiveWorkspaceContext value={contextValue}>
          <NativeWorkspaceInspectorContext
            value={{ render: workspaceInspector?.render, visible: inspectorColumnTargetWidth > 0 }}
          >
            {props.children}
          </NativeWorkspaceInspectorContext>
        </AdaptiveWorkspaceContext>
      </HomeListOptionsProvider>
    );
  }
  return (
    <HomeListOptionsProvider
      projectGroupingMode={projectGroupingMode}
      savedFilters={props.savedThreadListFilters}
    >
      <AdaptiveWorkspaceContext.Provider value={contextValue}>
        <View
          testID="adaptive-workspace-layout"
          className={Platform.OS === "android" ? "flex-1 flex-row bg-header" : "flex-1 flex-row"}
        >
          {shouldRenderNavigationRail ? (
            <Animated.View
              className="self-stretch overflow-hidden"
              accessibilityElementsHidden={navigationRailWidth === 0}
              importantForAccessibility={navigationRailWidth > 0 ? "auto" : "no-hide-descendants"}
              pointerEvents={navigationRailWidth > 0 ? "auto" : "none"}
              style={railAnimatedStyle}
            >
              <AndroidWorkspaceNavigation rail onSelect={revealPrimarySidebar} />
            </Animated.View>
          ) : null}
          {shouldRenderPrimarySidebar && layout.listPaneWidth !== null ? (
            <Animated.View
              className="self-stretch overflow-hidden"
              accessibilityElementsHidden={!panes.primarySidebarVisible}
              collapsable={false}
              importantForAccessibility={
                panes.primarySidebarVisible ? "auto" : "no-hide-descendants"
              }
              pointerEvents={panes.primarySidebarVisible ? "auto" : "none"}
              style={sidebarAnimatedStyle}
            >
              <View className="flex-1" style={{ width: layout.listPaneWidth }}>
                <RenderErrorBoundary
                  renderFallback={(fallback) => (
                    <RenderFailureView
                      {...fallback}
                      title="The sidebar couldn't be displayed"
                      exit={{ label: "Open settings", onPress: handleOpenSettings }}
                    />
                  )}
                >
                  <AndroidWorkspaceSidebar
                    onRequestVisibility={revealPrimarySidebar}
                    selectedPullRequestKey={props.selectedPullRequestKey ?? null}
                  >
                    <AndroidHomeFabLayout sidebar onStartNewTask={handleStartNewTask}>
                      <ThreadNavigationSidebar
                        width={layout.listPaneWidth}
                        visible={panes.primarySidebarVisible}
                        onRequestVisibility={revealPrimarySidebar}
                        selectedThreadKey={selectedThreadKey}
                        onOpenSettings={handleOpenSettings}
                        onOpenEnvironmentSettings={handleOpenEnvironmentSettings}
                        onNewThreadInProject={handleNewThreadInProject}
                        onNewThreadOnBranch={handleNewThreadOnBranch}
                        onSelectThread={handleSelectThread}
                        onSearchQueryChange={setPrimarySidebarSearchQuery}
                        searchQuery={primarySidebarSearchQuery}
                      />
                    </AndroidHomeFabLayout>
                  </AndroidWorkspaceSidebar>
                </RenderErrorBoundary>
              </View>
            </Animated.View>
          ) : null}
          <View
            className={
              Platform.OS === "android"
                ? "flex-1 overflow-hidden bg-header"
                : "flex-1 overflow-hidden bg-screen"
            }
            collapsable={false}
          >
            <View
              collapsable={false}
              style={
                contentSettledWidth !== null
                  ? {
                      flex: 1,
                      width: contentSettledWidth,
                    }
                  : { flex: 1 }
              }
            >
              <WorkspaceContentWidthContext
                value={layout.usesSplitView ? renderedContentWidth : null}
              >
                {props.children}
              </WorkspaceContentWidthContext>
            </View>
          </View>
          <WorkspaceInspectorPane
            pathname={props.pathname}
            renderedInspectorWidth={renderedInspectorWidth}
            active={workspaceInspector?.active ?? false}
            panes={panes}
            renderInspector={workspaceInspector?.render}
            setAuxiliaryPaneWidth={setAuxiliaryPaneWidth}
            onClosed={handleWorkspaceInspectorClosed}
          />
        </View>
      </AdaptiveWorkspaceContext.Provider>
    </HomeListOptionsProvider>
  );
}
