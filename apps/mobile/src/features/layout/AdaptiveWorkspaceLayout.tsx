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
  useEffect,
  useEffectEvent,
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
  alignListPaneToHinge,
  deriveLayout,
  type VerticalHinge,
  deriveWorkspacePaneLayout,
  isPrimarySidebarPinned,
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
import {
  AndroidWorkspaceNavigation,
  ANDROID_WORKSPACE_RAIL_WIDTH,
} from "../workspace/AndroidWorkspaceNavigation";
import { AndroidWorkspaceSidebar } from "../workspace/AndroidWorkspaceSidebar";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
import { HomeListOptionsProvider } from "../home/home-list-options";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";
import { useOpenThreadPullRequests } from "../threads/use-open-thread-pull-requests";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspaceInspectorPane } from "./workspace-inspector-pane";
import { WorkspaceContentWidthContext } from "./workspace-content-width";
import {
  NativeWorkspaceModeContext,
  NativeWorkspaceInspectorContext,
} from "../../native/v5-workspace-context";

import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { AndroidHingeObserver } from "../../native/AndroidHingeObserver";
import { WindowHingeContext } from "../../native/window-hinge-context";

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

  useFocusEffect(() => activateAuxiliaryPaneRole(role));
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

  const wrappedRender = (() => {
    if (render === undefined) {
      return undefined;
    }
    return () => (
      <NavigationContext.Provider value={navigation}>
        <NavigationRouteContext.Provider value={route}>{render()}</NavigationRouteContext.Provider>
      </NavigationContext.Provider>
    );
  })();

  const focusedRef = useRef(false);
  const deactivateRef = useRef<(() => void) | null>(null);

  // An effect event reads this render's pane without making the focus
  // subscription re-run (and deactivate) every time the pane closure changes.
  const syncRegistration = useEffectEvent(() => {
    if (!focusedRef.current || wrappedRender === undefined) {
      deactivateRef.current?.();
      return;
    }
    deactivateRef.current = registerWorkspaceInspector(wrappedRender);
  });

  useFocusEffect(() => {
    focusedRef.current = true;
    syncRegistration();
    return () => {
      focusedRef.current = false;
      syncRegistration();
    };
  });

  useEffect(() => {
    if (focusedRef.current) {
      syncRegistration();
    }
  }, [wrappedRender]);

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
  const pathname = props.pathname;
  // Android's Settings tab is a full workspace page: the rail stays, the sidebar and
  // auxiliary panes hide.
  const workspacePage = Platform.OS === "android" && pathname.startsWith("/settings");
  const navigation = useNavigation();
  const activeRoleOwner = useRef<symbol | null>(null);
  const [primarySidebarPreferredVisible, setPrimarySidebarPreferredVisible] = useState(true);
  const [supplementaryPanePreferredVisible, setSupplementaryPanePreferredVisible] = useState(true);
  const [supplementaryPanePreferredWidth, setSupplementaryPanePreferredWidth] = useState<
    number | null
  >(null);
  const [fileInspectorPreferredVisible, setFileInspectorPreferredVisible] = useState(true);
  const [fileInspectorPreferredWidth, setFileInspectorPreferredWidth] = useState<number | null>(
    null,
  );
  const [primarySidebarSearchQuery, setPrimarySidebarSearchQuery] = useState("");
  const [railOverlay, setRailOverlay] = useState(false);
  const [focusedAuxiliaryPaneRole, setFocusedAuxiliaryPaneRole] =
    useState<WorkspaceAuxiliaryPaneRole | null>(null);
  // The compiler can't memoize these derivations: they stay live across later hook calls. Fresh
  // objects here change the workspace context on every render, so every workspace screen
  // re-renders on any layout state change, and the inspector registration then loops: each
  // re-register re-renders its screen, which hands over a new inspector renderer.
  const baseLayout = useMemo(
    () => deriveLayout({ width: viewportWidth, height, nativeMetrics }),
    [height, viewportWidth, nativeMetrics],
  );
  const primarySidebarPinned = isPrimarySidebarPinned({
    pathname,
    nativeWorkspace,
    usesSplitView: baseLayout.usesSplitView,
  });
  const showPrimarySidebar =
    !workspacePage && (primarySidebarPinned || primarySidebarPreferredVisible);
  const shouldRenderNavigationRail = Platform.OS === "android" && baseLayout.usesSplitView;
  const navigationRailWidth =
    shouldRenderNavigationRail && (showPrimarySidebar || workspacePage)
      ? ANDROID_WORKSPACE_RAIL_WIDTH
      : 0;
  const [hinge, setHinge] = useState<VerticalHinge | null>(null);
  const [windowHinge, setWindowHinge] = useState<VerticalHinge | null>(null);
  const handleHingeChange = (next: VerticalHinge | null, nextWindow: VerticalHinge | null) => {
    setHinge(next);
    setWindowHinge(nextWindow);
  };
  const layout = useMemo(
    () =>
      alignListPaneToHinge({
        layout: baseLayout,
        hinge,
        viewportWidth,
        leadingWidth: navigationRailWidth,
      }),
    [baseLayout, hinge, navigationRailWidth, viewportWidth],
  );
  const width = viewportWidth - navigationRailWidth;
  // The sidebar stays mounted under a workspace page, so its list is ready on the way back.
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
    !workspacePage &&
    (auxiliaryPaneRole === "inspector"
      ? fileInspectorPreferredVisible
      : supplementaryPanePreferredVisible);
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
  const selectedThreadKey = (() => {
    if (environmentId === null || threadId === null) {
      return null;
    }
    try {
      return scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(threadId));
    } catch {
      return null;
    }
  })();
  const [workspaceInspector, setWorkspaceInspector] = useState<{
    readonly render: () => ReactNode;
    readonly active: boolean;
  } | null>(null);
  const workspaceInspectorOwner = useRef<symbol | null>(null);
  const registerWorkspaceInspector = (render: () => ReactNode) => {
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
  };
  const handleWorkspaceInspectorClosed = () => {
    setWorkspaceInspector((current) => (current !== null && !current.active ? null : current));
  };
  const activateAuxiliaryPaneRole = (role: WorkspaceAuxiliaryPaneRole) => {
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
  };
  const togglePrimarySidebar = () => {
    if (primarySidebarPinned) {
      return;
    }
    if (!panes.primarySidebarVisible && panes.primarySidebarSuppressedByAuxiliary) {
      setFileInspectorPreferredVisible(false);
      setPrimarySidebarPreferredVisible(true);
      return;
    }
    setPrimarySidebarPreferredVisible((current) => !current);
  };
  const revealPrimarySidebar = () => {
    if (panes.primarySidebarSuppressedByAuxiliary) {
      setFileInspectorPreferredVisible(false);
    }
    setPrimarySidebarPreferredVisible(true);
  };
  const handleToggleSidebarCommand = () => {
    togglePrimarySidebar();
    return true;
  };
  const sidebarCommands = primarySidebarPinned ? [] : (["toggleSidebar"] as const);
  useHardwareKeyboardCommand(sidebarCommands, handleToggleSidebarCommand);
  const showAuxiliaryPane = (role: WorkspaceAuxiliaryPaneRole) => {
    if (role === "inspector") {
      setFocusedAuxiliaryPaneRole("inspector");
      setFileInspectorPreferredVisible(true);
      return;
    }
    setFocusedAuxiliaryPaneRole("supplementary");
    setSupplementaryPanePreferredVisible(true);
  };
  const handleOpenFilesCommand = () => {
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
  };
  useHardwareKeyboardCommand("files", handleOpenFilesCommand);
  const toggleAuxiliaryPane = () => {
    if (auxiliaryPaneRole === "inspector") {
      setFileInspectorPreferredVisible((current) => !current);
      return;
    }
    setSupplementaryPanePreferredVisible((current) => !current);
  };
  const setAuxiliaryPaneWidth = (nextWidth: number) => {
    if (auxiliaryPaneRole === "inspector") {
      setFileInspectorPreferredWidth(nextWidth);
      return;
    }
    setSupplementaryPanePreferredWidth(nextWidth);
  };
  const handleOpenSettings = () => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "Settings" },
    });
  };

  const handleStartNewTask = () => {
    navigation.navigate("NewTaskSheet", { screen: "NewTask" });
  };

  // Minted here (root stack navigation) so the sidebar pane stays free of
  // navigation hooks — on iOS it renders inside an independent nav tree.
  const handleOpenEnvironmentSettings = () => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsEnvironments" },
    });
  };

  const handleOpenThreadPullRequests = useOpenThreadPullRequests();
  const { openPendingTask: handleOpenPendingTask } = usePendingTaskListActions();

  const handleNewThreadOnBranch = (thread: EnvironmentThreadShell) => {
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: String(thread.environmentId),
        projectId: String(thread.projectId),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    });
  };

  const handleNewThreadInProject = (project: EnvironmentProject) => {
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: String(project.environmentId),
        projectId: String(project.id),
        title: project.title,
      },
    });
  };

  const inspectorColumnTargetWidth =
    workspaceInspector !== null && workspaceInspector.active && panes.auxiliaryPaneVisible
      ? (panes.auxiliaryPaneWidth ?? 0)
      : 0;
  const contentTargetWidth = layout.usesSplitView
    ? Math.max(0, panes.contentPaneWidth - inspectorColumnTargetWidth)
    : null;
  const [contentSizing, setContentSizing] = useState({
    viewportWidth,
    workspacePage,
    target: contentTargetWidth,
    sidebarVisible: panes.primarySidebarVisible,
    width: contentTargetWidth,
    listPaneTarget: layout.listPaneWidth,
    listPaneFloor: layout.listPaneWidth,
    listPaneCeiling: layout.listPaneWidth,
    revision: 0,
  });
  if (
    Platform.OS === "android" &&
    (contentSizing.viewportWidth !== viewportWidth ||
      contentSizing.workspacePage !== workspacePage ||
      contentSizing.target !== contentTargetWidth ||
      contentSizing.sidebarVisible !== panes.primarySidebarVisible ||
      contentSizing.listPaneTarget !== layout.listPaneWidth)
  ) {
    // A workspace page swaps the sidebar in the same frame, so nothing animates to wait for.
    const sameViewport =
      contentSizing.viewportWidth === viewportWidth &&
      contentSizing.workspacePage === workspacePage;
    const openingSidebar =
      sameViewport && !contentSizing.sidebarVisible && panes.primarySidebarVisible;
    // A book-posture hinge resizes the visible list pane instead of revealing it.
    const resizingSidebar =
      sameViewport &&
      contentSizing.sidebarVisible &&
      panes.primarySidebarVisible &&
      contentSizing.listPaneTarget !== layout.listPaneWidth;
    const keepWide =
      (openingSidebar || resizingSidebar) &&
      contentSizing.width !== null &&
      contentTargetWidth !== null;
    setContentSizing({
      viewportWidth,
      workspacePage,
      target: contentTargetWidth,
      sidebarVisible: panes.primarySidebarVisible,
      // Clip the wide navigator while the sidebar opens or widens, then reflow once at the
      // end. Narrowing it first exposes an empty strip before the sidebar arrives.
      width: keepWide
        ? Math.max(contentSizing.width ?? 0, contentTargetWidth ?? 0)
        : contentTargetWidth,
      listPaneTarget: layout.listPaneWidth,
      // While a hinge resizes the list, its width follows the pane edge within this span. A
      // retarget mid-animation widens the span, since the edge is still somewhere inside it.
      listPaneFloor: resizingSidebar
        ? Math.min(contentSizing.listPaneFloor ?? 0, layout.listPaneWidth ?? 0)
        : layout.listPaneWidth,
      listPaneCeiling: resizingSidebar
        ? Math.max(contentSizing.listPaneCeiling ?? 0, layout.listPaneWidth ?? 0)
        : layout.listPaneWidth,
      revision: contentSizing.revision + 1,
    });
  }
  const settleContentWidth = (revision: number) => {
    setContentSizing((current) =>
      current.revision !== revision ||
      (current.width === current.target &&
        current.listPaneFloor === current.listPaneTarget &&
        current.listPaneCeiling === current.listPaneTarget)
        ? current
        : {
            ...current,
            width: current.target,
            listPaneFloor: current.listPaneTarget,
            listPaneCeiling: current.listPaneTarget,
          },
    );
  };
  const listPaneFloor = contentSizing.listPaneFloor ?? 0;
  const listPaneCeiling = contentSizing.listPaneCeiling ?? 0;
  const contentSettledWidth = Platform.OS === "android" ? contentSizing.width : contentTargetWidth;
  const contentRevision = contentSizing.revision;

  const renderedSidebarWidth = useSharedValue(
    panes.primarySidebarVisible ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0) : 0,
  );
  const renderedRailWidth = useSharedValue(navigationRailWidth);
  const leavingWorkspacePage = useRef(false);
  useEffect(() => {
    if (nativeWorkspace) return;
    renderedRailWidth.set(withTiming(navigationRailWidth, WORKSPACE_PANE_TIMING));
    // A workspace page hides the sidebar through React instead, in the same commit that mounts
    // the page. Animating it here would hide it a few frames before the page appears.
    if (workspacePage) {
      leavingWorkspacePage.current = true;
      return;
    }
    const snap = leavingWorkspacePage.current;
    leavingWorkspacePage.current = false;
    const targetWidth = panes.primarySidebarVisible
      ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0)
      : 0;
    // The content beside it already took its final width when the page closed.
    renderedSidebarWidth.set(
      withTiming(targetWidth, snap ? { duration: 0 } : WORKSPACE_PANE_TIMING, (finished) => {
        if (finished && Platform.OS === "android") runOnJS(settleContentWidth)(contentRevision);
      }),
    );
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
    workspacePage,
  ]);
  const railAnimatedStyle = useAnimatedStyle(() => ({ width: renderedRailWidth.value }));
  // Showing or hiding the sidebar clips a fixed-width list. A hinge resize instead tracks the
  // animated edge, so the header actions slide with it rather than jumping or being covered.
  const listPaneGap = layout.listPaneGap ?? 0;
  const listPaneAnimatedStyle = useAnimatedStyle(() => ({
    width: Math.min(
      listPaneCeiling,
      Math.max(listPaneFloor, renderedSidebarWidth.value - listPaneGap),
    ),
  }));
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
  const handleSelectThread = (thread: EnvironmentThreadShell) => {
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
  };

  const contextValue = {
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
  };

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
        <WindowHingeContext value={windowHinge}>
          <View
            testID="adaptive-workspace-layout"
            className={Platform.OS === "android" ? "flex-1 flex-row bg-header" : "flex-1 flex-row"}
          >
            <AndroidHingeObserver onChange={handleHingeChange} />
            {shouldRenderNavigationRail ? (
              <Animated.View className="self-stretch" style={railAnimatedStyle} />
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
                // Under a workspace page the sidebar leaves the row but keeps its size, so its
                // lists never lay out at zero size and are ready, unchanged, on the way back. The
                // content pane, laid out after it, covers it, in the same mount as the page.
                style={[
                  workspacePage ? { position: "absolute", top: 0, bottom: 0, left: 0 } : null,
                  sidebarAnimatedStyle,
                ]}
              >
                <Animated.View className="flex-1" style={listPaneAnimatedStyle}>
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
                          onOpenPendingTask={handleOpenPendingTask}
                          onSelectThread={handleSelectThread}
                          onOpenThreadPullRequests={handleOpenThreadPullRequests}
                          onSearchQueryChange={setPrimarySidebarSearchQuery}
                          searchQuery={primarySidebarSearchQuery}
                        />
                      </AndroidHomeFabLayout>
                    </AndroidWorkspaceSidebar>
                  </RenderErrorBoundary>
                </Animated.View>
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
            {shouldRenderNavigationRail && navigationRailWidth > 0 ? (
              // The rail reserves its slot above and draws over the panes, so it can widen over
              // the list in place. It takes the whole workspace only while it is open.
              <View
                className="absolute inset-y-0 left-0"
                style={railOverlay ? { right: 0 } : { width: navigationRailWidth }}
              >
                <AndroidWorkspaceNavigation
                  rail
                  onSelect={revealPrimarySidebar}
                  onOverlayChange={setRailOverlay}
                />
              </View>
            ) : null}
          </View>
        </WindowHingeContext>
      </AdaptiveWorkspaceContext.Provider>
    </HomeListOptionsProvider>
  );
}
