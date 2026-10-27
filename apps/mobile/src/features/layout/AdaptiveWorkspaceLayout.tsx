import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveWorkspaceContext, useAdaptiveWorkspaceLayout } from "./adaptive-workspace-context";
import { threadSelectionDeferral } from "./deferred-navigation";
import { uuidv4 } from "../../lib/uuid";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { NavigationContext, NavigationRouteContext, useNavigation } from "@react-navigation/native";
import { use, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, useWindowDimensions, View } from "react-native";
import { KeyboardController, useKeyboardState } from "react-native-keyboard-controller";
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
  isWorkspaceListPath,
  type WorkspaceAuxiliaryPaneRole,
} from "../../lib/layout";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type { ThreadListFilters } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects } from "../../state/entities";
import { useThreadCwd } from "../../state/use-selected-thread-worktree";
import { environmentThreadShells } from "../../state/threads";
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
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
  type WorkspaceDetailSheet,
} from "../workspace/workspace-detail-selection";
import { startOpeningDetail } from "../workspace/useSelectWorkspaceDetail";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { HomeListOptionsProvider } from "../home/home-list-options";
import { newTaskDestination } from "../threads/new-task-project-selection";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";
import { useOpenThreadPullRequests } from "../threads/use-open-thread-pull-requests";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspaceInspectorPane } from "./workspace-inspector-pane";
import {
  WorkspaceContentWidthContext,
  WorkspaceSettledContentWidthContext,
} from "./workspace-content-width";
import {
  NativeWorkspaceModeContext,
  NativeWorkspaceInspectorContext,
} from "../../native/v5-workspace-context";

import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { AndroidHingeObserver } from "../../native/AndroidHingeObserver";
import { WindowHingeContext } from "../../native/window-hinge-context";
import { useAndroidWorkspaceRoot } from "../workspace/AndroidWorkspaceTabsProvider";
import { openSettings } from "../settings/settings-navigation";
import { dispatchRootStackReset, rootStackState } from "../../lib/root-stack-reset";
import {
  currentWorkspaceSelections,
  workspaceSelectionCheck,
} from "../workspace/workspace-selection-store";
import {
  workspaceTabColumns,
  workspaceTabNavigationState,
} from "../workspace/workspace-tab-navigation";
import type { WorkspaceTab } from "../workspace/workspace-tabs-state";
import { workspaceRoutesOf } from "./workspace-overlay-routes";
import { SettingsWorkspaceLayout } from "../settings/SettingsWorkspaceLayout";

export { useAdaptiveWorkspaceLayout };

export function useAdaptiveWorkspacePaneRole(role: WorkspaceAuxiliaryPaneRole) {
  const { activateAuxiliaryPaneRole } = useAdaptiveWorkspaceLayout();

  useFocusEffect(() => activateAuxiliaryPaneRole(role));
}

/** Capture inspector navigation contexts. Register on focus events because frozen blurred screens may never clean up. */
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

  // useFocusEffect re-runs when the renderer changes while focused, so the
  // pane always shows this render's content, and its cleanup deactivates on
  // blur and unmount.
  useFocusEffect(() =>
    wrappedRender === undefined ? undefined : registerWorkspaceInspector(wrappedRender),
  );
}

export function AdaptiveWorkspaceLayout(props: {
  readonly children: ReactNode;
  readonly pathname: string;
  readonly workspaceRouteKey: string | undefined;
  readonly workspaceRouteName: string | undefined;
  readonly workspaceRouteKeys: ReadonlyArray<string>;
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
    readonly workspaceRouteName: string | undefined;
    readonly workspaceRouteKeys: ReadonlyArray<string>;
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
  const workspace = useWorkspaceTabs();
  // Settings and Usage occupy the workspace rather than a list/detail pair.
  const androidSettingsOpen = useAndroidWorkspaceRoot()?.settingsOpen ?? false;
  const safeAreaInsets = useSafeAreaInsets();
  const workspacePage =
    Platform.OS === "android" && (androidSettingsOpen || workspace?.state.selectedTab === "usage");
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
    () => deriveLayout({ width: viewportWidth, height, nativeMetrics, nativeWorkspace }),
    [height, viewportWidth, nativeMetrics, nativeWorkspace],
  );
  // The overlay sidebar closes when a page opens from it, and stays open on a list or on the
  // page a tab switch opened (`keepOpenFor`, set by that switch).
  const [overlaySidebar, setOverlaySidebar] = useState({
    active: baseLayout.primarySidebarOverlaysContent,
    pathname,
    visible: isWorkspaceListPath(pathname),
    keepOpenFor: null as string | null,
  });
  if (
    overlaySidebar.active !== baseLayout.primarySidebarOverlaysContent ||
    (overlaySidebar.active && overlaySidebar.pathname !== pathname)
  ) {
    setOverlaySidebar({
      active: baseLayout.primarySidebarOverlaysContent,
      pathname,
      visible:
        isWorkspaceListPath(pathname) ||
        (overlaySidebar.keepOpenFor !== null &&
          overlaySidebar.keepOpenFor === props.workspaceRouteKey),
      keepOpenFor: null,
    });
  }
  const preferredSidebarVisible = baseLayout.primarySidebarOverlaysContent
    ? overlaySidebar.visible
    : primarySidebarPreferredVisible;
  const primarySidebarPinned = isPrimarySidebarPinned({
    pathname,
    nativeWorkspace,
    usesSplitView: baseLayout.usesSplitView,
  });
  const [composerEditing, setComposerEditing] = useState(false);
  const softKeyboardVisible = useKeyboardState((state) => state.isVisible);
  // Keyed on the soft keyboard, not focus: a hardware keyboard leaves room for the sidebar, and
  // Back closes the keyboard while the editor keeps focus. Deferred so the composer commits its
  // keyboard render first; relaying out in the same commit held it behind the keyboard.
  const composerKeyboardActive = useDeferredValue(
    Platform.OS === "android" && baseLayout.usesSplitView && composerEditing && softKeyboardVisible,
  );
  const showPrimarySidebar =
    !workspacePage &&
    (primarySidebarPinned || (preferredSidebarVisible && !composerKeyboardActive));
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
          shouldRenderPrimarySidebar && showPrimarySidebar && !layout.primarySidebarOverlaysContent
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
        nativeWorkspace,
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
      nativeWorkspace,
      showPrimarySidebar,
      width,
    ],
  );
  const activeThread = parseActiveThreadPath(pathname);
  const environmentId = activeThread?.environmentId ?? null;
  const threadId = activeThread?.threadId ?? null;
  const selectedThreadRef = (() => {
    if (environmentId === null || threadId === null) {
      return null;
    }
    try {
      return {
        environmentId: EnvironmentId.make(environmentId),
        threadId: ThreadId.make(threadId),
      };
    } catch {
      return null;
    }
  })();
  const selectedThreadKey =
    selectedThreadRef === null
      ? null
      : scopedThreadKey(selectedThreadRef.environmentId, selectedThreadRef.threadId);
  const isFilesRoute = props.workspaceRouteName === "ThreadFiles";
  // Same resolution the Files screen uses: without a cwd it shows "Files unavailable" and
  // registers no inspector, so revealing would only hide the sidebar beside that screen.
  const filesCwd = useThreadCwd(isFilesRoute && fileInspector.supported ? selectedThreadRef : null);
  // Opening a review or the files route reveals its inspector once per route and thread.
  // Routes still on the stack remember their reveal, so going back to one keeps the user's choice.
  const revealsInspector =
    props.workspaceRouteName === "ThreadReview" || (isFilesRoute && filesCwd !== null);
  const [revealedInspectors, setRevealedInspectors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  if (
    revealsInspector &&
    props.workspaceRouteKey !== undefined &&
    selectedThreadKey !== null &&
    revealedInspectors.get(props.workspaceRouteKey) !== selectedThreadKey
  ) {
    const next = new Map<string, string>();
    for (const routeKey of props.workspaceRouteKeys) {
      const revealedThreadKey = revealedInspectors.get(routeKey);
      if (revealedThreadKey !== undefined) {
        next.set(routeKey, revealedThreadKey);
      }
    }
    next.set(props.workspaceRouteKey, selectedThreadKey);
    setRevealedInspectors(next);
    setFocusedAuxiliaryPaneRole("inspector");
    setFileInspectorPreferredVisible(true);
  }
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
      // Outgoing screens deactivate after incoming registration; only the current owner may deactivate.
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
  const setPrimarySidebarVisible = (visible: boolean) => {
    if (layout.primarySidebarOverlaysContent) {
      setOverlaySidebar((current) => ({ ...current, visible }));
    } else {
      setPrimarySidebarPreferredVisible(visible);
    }
  };
  const togglePrimarySidebar = () => {
    if (primarySidebarPinned) {
      return;
    }
    // A sidebar the keyboard set aside returns with the keyboard; the user's preference stays
    // intact. One the user had hidden still opens.
    if (composerKeyboardActive) {
      void KeyboardController.dismiss();
      if (primarySidebarPreferredVisible) return;
    }
    if (!panes.primarySidebarVisible && panes.primarySidebarSuppressedByAuxiliary) {
      setFileInspectorPreferredVisible(false);
      setPrimarySidebarPreferredVisible(true);
      return;
    }
    setPrimarySidebarVisible(!preferredSidebarVisible);
  };
  const revealPrimarySidebar = () => {
    if (composerKeyboardActive) void KeyboardController.dismiss();
    if (panes.primarySidebarSuppressedByAuxiliary) {
      setFileInspectorPreferredVisible(false);
    }
    setPrimarySidebarVisible(true);
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
  /**
   * The one way to open a workspace tab: replaces the workspace with the tab's list and, when the
   * window has columns, the page it last showed, keeping any sheet on top. An overlay sidebar
   * stays open over that page.
   */
  const openWorkspaceTab = (
    tab: WorkspaceTab | "settings",
    options?: { readonly columns?: boolean },
  ) => {
    const state = rootStackState(navigation);
    if (!state) return;
    const { workspace, overlays } = workspaceRoutesOf(state.routes.slice(0, state.index + 1));
    const next = workspaceTabNavigationState(
      { ...state, routes: workspace },
      tab,
      currentWorkspaceSelections(),
      {
        columns: workspaceTabColumns(Platform.OS, tab, options?.columns ?? layout.usesSplitView),
        check: workspaceSelectionCheck,
        overlays,
      },
    );
    if (layout.primarySidebarOverlaysContent) {
      const opened = next.routes.at(-1 - overlays.length)?.key ?? null;
      setOverlaySidebar((current) => ({ ...current, visible: true, keepOpenFor: opened }));
    }
    dispatchRootStackReset(navigation, state, next);
  };
  const handleOpenSettings = () => openWorkspaceTab("settings");

  /** The one way to show a page in the detail column; see `selectWorkspaceDetail`. */
  function handleSelectDetail(detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) {
    threadSelectionDeferral.run(() => {
      if (Platform.OS === "android") Keyboard.dismiss();
      setFileInspectorPreferredVisible(false);
      if (layout.primarySidebarOverlaysContent) setPrimarySidebarVisible(false);
      workspace?.dispatch({
        type: "select",
        tab: detail.name === "Thread" ? "threads" : "pullRequests",
      });
      startOpeningDetail(detail);
      navigation.dispatch(selectWorkspaceDetail(detail, sheet));
    });
  }
  const handleSelectThreadRoute = (params: ReactNavigation.RootParamList["Thread"]) =>
    handleSelectDetail({ name: "Thread", params });

  const projects = useProjects();
  const compactAndroidSettings =
    Platform.OS === "android" && androidSettingsOpen && !layout.usesSplitView;
  // Reads the open page when pressed, so the layout context doesn't change on every navigation.
  const handleStartNewTask = () => {
    const state = rootStackState(navigation);
    const currentRoute = workspaceRoutesOf(
      state?.routes.slice(0, state.index + 1) ?? [],
    ).workspace.at(-1);
    const params =
      currentRoute?.name === "Thread"
        ? (currentRoute.params as ReactNavigation.RootParamList["Thread"])
        : undefined;
    const first = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;
    const environmentId = first(params?.environmentId);
    const threadId = first(params?.threadId);
    // The full index, not the sidebar list: subagent and archived threads are current threads too.
    const projectId =
      environmentId && threadId
        ? appAtomRegistry
            .get(
              environmentThreadShells.environmentThreadIndexAtom(EnvironmentId.make(environmentId)),
            )
            .get(ThreadId.make(threadId))?.projectId
        : undefined;
    const preferences = appAtomRegistry.get(mobilePreferencesAtom);
    const saved = AsyncResult.isSuccess(preferences) ? preferences.value : undefined;
    handleSelectThreadRoute(
      newTaskDestination({
        projects,
        requestId: uuidv4(),
        useLastProject: saved?.useLastProjectForNewThreads,
        currentProject: environmentId && projectId ? { environmentId, projectId } : undefined,
        lastProject: saved?.lastThreadProject,
      }),
    );
  };

  useHardwareKeyboardCommand("newTask", () => {
    handleStartNewTask();
    return true;
  });

  // Create at root: the iOS sidebar renders in an independent navigation tree.
  const handleOpenEnvironmentSettings = () => {
    openSettings(navigation, "SettingsEnvironments");
  };

  const handleOpenThreadPullRequests = useOpenThreadPullRequests();
  const { openPendingTask: handleOpenPendingTask } =
    usePendingTaskListActions(handleSelectThreadRoute);

  const handleNewThreadOnBranch = (thread: EnvironmentThreadShell) => {
    handleSelectThreadRoute({
      draft: {
        requestId: uuidv4(),
        environmentId: String(thread.environmentId),
        projectId: String(thread.projectId),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    });
  };

  const handleNewThreadInProject = (project: EnvironmentProject) => {
    handleSelectThreadRoute({
      draft: {
        requestId: uuidv4(),
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
  const [listPaneSizing, setListPaneSizing] = useState({
    viewportWidth,
    workspacePage,
    sidebarVisible: panes.primarySidebarVisible,
    listPaneTarget: layout.listPaneWidth,
    listPaneFloor: layout.listPaneWidth,
    listPaneCeiling: layout.listPaneWidth,
    revision: 0,
  });
  if (
    Platform.OS === "android" &&
    (listPaneSizing.viewportWidth !== viewportWidth ||
      listPaneSizing.workspacePage !== workspacePage ||
      listPaneSizing.sidebarVisible !== panes.primarySidebarVisible ||
      listPaneSizing.listPaneTarget !== layout.listPaneWidth)
  ) {
    // A book-posture hinge resizes the visible list pane instead of revealing it.
    const resizingSidebar =
      listPaneSizing.viewportWidth === viewportWidth &&
      listPaneSizing.workspacePage === workspacePage &&
      listPaneSizing.sidebarVisible &&
      panes.primarySidebarVisible &&
      listPaneSizing.listPaneTarget !== layout.listPaneWidth;
    setListPaneSizing({
      viewportWidth,
      workspacePage,
      sidebarVisible: panes.primarySidebarVisible,
      listPaneTarget: layout.listPaneWidth,
      // Retargets widen the list-width span because the animated hinge edge may still be inside it.
      listPaneFloor: resizingSidebar
        ? Math.min(listPaneSizing.listPaneFloor ?? 0, layout.listPaneWidth ?? 0)
        : layout.listPaneWidth,
      listPaneCeiling: resizingSidebar
        ? Math.max(listPaneSizing.listPaneCeiling ?? 0, layout.listPaneWidth ?? 0)
        : layout.listPaneWidth,
      revision: listPaneSizing.revision + 1,
    });
  }
  const settleListPane = (revision: number) => {
    setListPaneSizing((current) =>
      current.revision !== revision ||
      (current.listPaneFloor === current.listPaneTarget &&
        current.listPaneCeiling === current.listPaneTarget)
        ? current
        : {
            ...current,
            listPaneFloor: current.listPaneTarget,
            listPaneCeiling: current.listPaneTarget,
          },
    );
  };
  const listPaneFloor = listPaneSizing.listPaneFloor ?? 0;
  const listPaneCeiling = listPaneSizing.listPaneCeiling ?? 0;
  const listPaneRevision = listPaneSizing.revision;
  // Android lays the content out at its new width as soon as a pane toggles, then holds it
  // against the edge that stays put while the other one slides, so nothing reflows after the
  // panes land. A sliding sidebar uncovers the strip it is about to fill, or covers the content
  // until it is gone.
  const contentLeftTarget =
    navigationRailWidth +
    (shouldRenderPrimarySidebar && !workspacePage && panes.primarySidebarVisible
      ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0)
      : 0);
  const [contentAnchor, setContentAnchor] = useState({
    viewportWidth,
    left: contentLeftTarget,
    inspector: inspectorColumnTargetWidth,
    end: false,
  });
  if (
    Platform.OS === "android" &&
    (contentAnchor.viewportWidth !== viewportWidth ||
      contentAnchor.left !== contentLeftTarget ||
      contentAnchor.inspector !== inspectorColumnTargetWidth)
  ) {
    setContentAnchor({
      viewportWidth,
      left: contentLeftTarget,
      inspector: inspectorColumnTargetWidth,
      end:
        contentAnchor.viewportWidth === viewportWidth &&
        contentAnchor.inspector === inspectorColumnTargetWidth,
    });
  }

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
        if (finished && Platform.OS === "android") runOnJS(settleListPane)(listPaneRevision);
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
    settleListPane,
    listPaneRevision,
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

  // Clip the navigator at its settled width so native headers and markdown reflow only once per pane toggle.
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

  const handleSelectThread = (thread: EnvironmentThreadShell) => {
    handleSelectThreadRoute({
      environmentId: String(thread.environmentId),
      threadId: String(thread.id),
    });
  };

  // Rotating flips the overlay; until the new size reaches JS, predict the reset above.
  const sidebarOverRotates =
    nativeWorkspace && nativeMetrics?.hasHinge === true && layout.usesSplitView;
  // The current orientation's panes already account for an inspector that needs the sidebar's room.
  const sidebarInLandscape = baseLayout.primarySidebarOverlaysContent
    ? primarySidebarPinned || primarySidebarPreferredVisible
    : panes.primarySidebarVisible;
  const sidebarInPortrait =
    primarySidebarPinned ||
    (baseLayout.primarySidebarOverlaysContent
      ? overlaySidebar.visible
      : isWorkspaceListPath(pathname));
  const sidebarByOrientation = useMemo(
    () =>
      sidebarOverRotates ? { landscape: sidebarInLandscape, portrait: sidebarInPortrait } : null,
    [sidebarInLandscape, sidebarInPortrait, sidebarOverRotates],
  );

  const contextValue = {
    layout,
    panes,
    fileInspector,
    primarySidebarSearchQuery,
    startNewTask: handleStartNewTask,
    selectDetail: handleSelectDetail,
    activateAuxiliaryPaneRole,
    registerWorkspaceInspector,
    setPrimarySidebarSearchQuery,
    showAuxiliaryPane,
    toggleAuxiliaryPane,
    togglePrimarySidebar,
    setPrimarySidebarVisible,
    openWorkspaceTab,
    setAuxiliaryPaneWidth,
    composerKeyboardActive,
    setComposerEditing,
    sidebarByOrientation,
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
                  contentTargetWidth !== null
                    ? {
                        flex: 1,
                        width: contentTargetWidth,
                        alignSelf: contentAnchor.end ? "flex-end" : "flex-start",
                      }
                    : { flex: 1 }
                }
              >
                {/* Android holds the content still, so its floating controls keep its width. */}
                <WorkspaceContentWidthContext
                  value={
                    layout.usesSplitView && Platform.OS !== "android" ? renderedContentWidth : null
                  }
                >
                  <WorkspaceSettledContentWidthContext
                    value={
                      Platform.OS === "android" && layout.usesSplitView ? contentTargetWidth : null
                    }
                  >
                    {/* Compact Settings keeps the bottom navigation under all of its pages. */}
                    <SafeAreaInsetsContext
                      value={
                        compactAndroidSettings ? { ...safeAreaInsets, bottom: 0 } : safeAreaInsets
                      }
                    >
                      <View className="flex-1">
                        <SettingsWorkspaceLayout>{props.children}</SettingsWorkspaceLayout>
                      </View>
                    </SafeAreaInsetsContext>
                    {compactAndroidSettings ? (
                      <AndroidWorkspaceNavigation onNewThread={handleStartNewTask} />
                    ) : null}
                  </WorkspaceSettledContentWidthContext>
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
                  onNewThread={handleStartNewTask}
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
