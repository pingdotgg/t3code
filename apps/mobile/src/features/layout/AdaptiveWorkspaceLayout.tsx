import {
  WorkspaceColumnsRendererContext,
  WorkspacePresentationHostContext,
} from "./workspace-presentation-context";
import { useAndroidFloatingTabs } from "../settings/appearance/AppearancePreferencesProvider";
import { useSoftKeyboardShowing } from "../keyboard/useSoftKeyboardShowing";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveWorkspaceContext, useAdaptiveWorkspaceLayout } from "./adaptive-workspace-context";
import { threadSelectionDeferral } from "./deferred-navigation";
import { uuidv4 } from "../../lib/uuid";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { EnvironmentId, ThreadId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { NavigationContext, NavigationRouteContext, useNavigation } from "@react-navigation/native";
import {
  use,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
} from "react-native";
import {
  KeyboardController,
  useKeyboardContext,
  useKeyboardState,
} from "react-native-keyboard-controller";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AsyncResult } from "effect/reactivity";

import {
  chatFitsBesideSidebar,
  deriveFileInspectorPaneLayout,
  alignListPaneToHinge,
  deriveLayout,
  type VerticalHinge,
  deriveWorkspacePaneLayout,
  isPrimarySidebarPinned,
  isWorkspaceListPath,
  nativeInspectorColumnWidth,
} from "../../lib/layout";
import type { ThreadListFilters } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { withKnownPullRequestSummary } from "../../state/use-thread-pr";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping";
import {
  parseActiveThreadPath,
  useHardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useEnabledNavigationTabs } from "./workspace/navigation-tabs";
import { FLOATING_TABS, floatingTabsMetrics } from "./workspace/floating-workspace-tabs";
import {
  AndroidWorkspaceNavigation,
  FloatingWorkspaceTabs,
  ANDROID_WORKSPACE_RAIL_WIDTH,
} from "./workspace/AndroidWorkspaceNavigation";
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
  type WorkspaceDetailSheet,
} from "./workspace/workspace-detail-selection";
import { startOpeningDetail } from "./workspace/useSelectWorkspaceDetail";
import { useWorkspaceTabs } from "./workspace/WorkspaceTabsContext";
import { HomeListOptionsProvider } from "../home/home-list-options";
import { newTaskDestination } from "../threads/new-task-project-selection";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { PaneContext } from "../../components/ui/Pane";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspaceInspectorPane } from "./workspace-inspector-pane";
import { WorkspaceInspectorSheet } from "./workspace-inspector-sheet";
import type { InspectorContent } from "./inspector-panes";
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
import { useAndroidWorkspaceRoot } from "./workspace/AndroidWorkspaceTabsProvider";
import { dispatchRootStackReset, rootStackState } from "../../lib/root-stack-reset";
import {
  currentWorkspaceSelections,
  workspaceSelectionCheck,
} from "./workspace/workspace-selection-store";
import {
  workspaceTabColumns,
  workspaceTabNavigationState,
} from "./workspace/workspace-tab-navigation";
import type { WorkspaceTab } from "./workspace/workspace-tabs-state";
import { workspaceRoutesOf } from "./workspace-overlay-routes";
import { SettingsWorkspaceLayout } from "../settings/SettingsWorkspaceLayout";
import { WorkspaceThreadSidebar } from "./workspace/WorkspaceThreadSidebar";

export { useAdaptiveWorkspaceLayout };

/**
 * Shows these panes in the workspace's inspector while this screen is focused. Register on focus
 * events because frozen blurred screens may never clean up.
 */
export function Inspector(props: {
  readonly content: InspectorContent;
  /** Opens the column the first time this key registers while its route stays on the stack. */
  readonly revealKey?: string;
}) {
  const { registerWorkspaceInspector } = useAdaptiveWorkspaceLayout();
  const navigation = use(NavigationContext);
  const route = use(NavigationRouteContext);
  const content: InspectorContent = {
    ...props.content,
    resetKeys: [route?.key, ...(props.content.resetKeys ?? [])],
    panes: props.content.panes.map((pane) => ({
      ...pane,
      render: () => (
        <NavigationContext.Provider value={navigation}>
          <NavigationRouteContext.Provider value={route}>
            {pane.render()}
          </NavigationRouteContext.Provider>
        </NavigationContext.Provider>
      ),
    })),
  };
  const focusedRef = useRef(false);
  const deactivateRef = useRef<(() => void) | null>(null);

  const syncRegistration = useEffectEvent(() => {
    if (!focusedRef.current) {
      deactivateRef.current?.();
      return;
    }
    deactivateRef.current = registerWorkspaceInspector(content, route?.key, props.revealKey);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Navigation focus events own the inspector registration lifetime.
  useEffect(() => {
    if (navigation === undefined) return;
    const focus = () => {
      if (focusedRef.current) return;
      focusedRef.current = true;
      syncRegistration();
    };
    const blur = () => {
      focusedRef.current = false;
      syncRegistration();
    };
    if (navigation.isFocused()) focus();
    const unsubscribeFocus = navigation.addListener("focus", focus);
    const unsubscribeBlur = navigation.addListener("blur", blur);
    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
      focusedRef.current = false;
      deactivateRef.current?.();
      deactivateRef.current = null;
    };
  }, [navigation]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Changed column content replaces the focused inspector registration.
  useEffect(() => {
    if (focusedRef.current) {
      syncRegistration();
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Changed column content replaces its existing native workspace registration.
  }, [props.content, props.revealKey]);
  return null;
}

export function AdaptiveWorkspaceLayout(props: {
  readonly children: ReactNode;
  readonly pathname: string;
  readonly workspaceRouteKey: string | undefined;
  readonly workspaceRouteName: string | undefined;
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
  } & {
    readonly projectGroupingMode: SidebarProjectGroupingMode;
    readonly savedThreadListFilters?: ThreadListFilters | undefined;
  },
) {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const projectGroupingMode = props.projectGroupingMode;
  const nativeWorkspace = use(NativeWorkspaceModeContext);
  const usesPresentationHost = use(WorkspacePresentationHostContext);
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
  const [primarySidebarPreferredVisible, setPrimarySidebarPreferredVisible] = useState(true);
  const [fileInspectorPreferredVisible, setFileInspectorPreferredVisible] = useState(true);
  const [nativeInspectorWidthFraction, setNativeInspectorWidthFraction] = useState(0.4);
  const horizontalSafeArea =
    (nativeMetrics?.safeArea.left ?? 0) + (nativeMetrics?.safeArea.right ?? 0);
  const inspectorWidthFor = (fraction: number) =>
    nativeInspectorColumnWidth({ viewportWidth, horizontalSafeArea, fraction });
  const nativeInspectorWidth = inspectorWidthFor(nativeInspectorWidthFraction);
  const [fileInspectorPreferredWidth, setFileInspectorPreferredWidth] = useState<number | null>(
    null,
  );
  const [primarySidebarSearchQuery, setPrimarySidebarSearchQuery] = useState("");
  const [railOverlay, setRailOverlay] = useState(false);
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
    active: baseLayout.variant === "medium",
    pathname,
    visible: isWorkspaceListPath(pathname),
    keepOpenFor: null as string | null,
  });
  if (
    overlaySidebar.active !== (baseLayout.variant === "medium") ||
    (overlaySidebar.active && overlaySidebar.pathname !== pathname)
  ) {
    setOverlaySidebar({
      active: baseLayout.variant === "medium",
      pathname,
      visible:
        isWorkspaceListPath(pathname) ||
        (overlaySidebar.keepOpenFor !== null &&
          overlaySidebar.keepOpenFor === props.workspaceRouteKey),
      keepOpenFor: null,
    });
  }
  const preferredSidebarVisible =
    baseLayout.variant === "medium" ? overlaySidebar.visible : primarySidebarPreferredVisible;
  const primarySidebarPinned = isPrimarySidebarPinned({
    pathname,
    nativeWorkspace,
    usesSplitView: baseLayout.usesSplitView,
  });
  const [composerEditing, setComposerEditing] = useState(false);
  const softKeyboardVisible = useSoftKeyboardShowing();
  // Keyed on the soft keyboard, not focus: a hardware keyboard leaves room for the sidebar, and
  // Back closes the keyboard while the editor keeps focus. The sidebar returns as the keyboard
  // starts hiding, not after. Deferred so the composer commits its keyboard render first;
  // relaying out in the same commit held it behind the keyboard.
  const composerKeyboardActive = useDeferredValue(
    Platform.OS === "android" && baseLayout.usesSplitView && composerEditing && softKeyboardVisible,
  );
  const sidebarWithoutKeyboard =
    !workspacePage && (primarySidebarPinned || preferredSidebarVisible);
  // Medium windows float the sidebar over a page; beside a list it keeps its room.
  const sidebarFloats =
    baseLayout.variant === "medium" &&
    (nativeWorkspace || (!primarySidebarPinned && !workspacePage));
  const keyboardProgress = useKeyboardContext().reanimated.progress;
  // From the moment the keyboard starts showing until it has fully hidden. The detail pane keeps
  // the sidebar's room for that whole span, so on the way back the sidebar pushes the wide pane
  // aside instead of arriving beside one that already shrank.
  const keyboardOnScreen = useKeyboardState((state) => state.isVisible);
  const shouldRenderNavigationRail =
    Platform.OS === "android" && baseLayout.usesSplitView && !floatingTabsEnabled;
  const enabledTabs = useEnabledNavigationTabs();
  const { scale, fabSize } = useAndroidControlSizing();
  const floatingTabs = floatingTabsMetrics(enabledTabs.length + 1, scale, fabSize);
  // The rail stays whether or not the sidebar shows; only the list pane comes and goes.
  const navigationRailWidth = shouldRenderNavigationRail ? ANDROID_WORKSPACE_RAIL_WIDTH : 0;
  const [hinge, setHinge] = useState<VerticalHinge | null>(null);
  const [windowHinge, setWindowHinge] = useState<VerticalHinge | null>(null);
  const handleHingeChange = (next: VerticalHinge | null, nextWindow: VerticalHinge | null) => {
    setHinge(next);
    setWindowHinge(nextWindow);
  };
  const layout = useMemo(() => {
    const aligned = alignListPaneToHinge({
      layout: baseLayout,
      hinge,
      viewportWidth,
      leadingWidth: navigationRailWidth,
    });
    if (
      !floatingTabsEnabled ||
      !aligned.usesSplitView ||
      aligned.listPaneGap !== undefined ||
      aligned.listPaneWidth === null ||
      aligned.listPaneWidth >= floatingTabs.row ||
      viewportWidth - floatingTabs.row < 320
    )
      return aligned;
    return { ...aligned, listPaneWidth: floatingTabs.row };
  }, [
    baseLayout,
    hinge,
    navigationRailWidth,
    viewportWidth,
    floatingTabs.row,
    floatingTabsEnabled,
  ]);
  // A floating sidebar brings the rail with it.
  const width = viewportWidth - (sidebarFloats ? 0 : navigationRailWidth);
  // The sidebar stays mounted under a workspace page, so its list is ready on the way back.
  const shouldRenderPrimarySidebar = layout.usesSplitView;
  const [workspaceInspector, setWorkspaceInspector] = useState<{
    readonly content: InspectorContent;
    readonly active: boolean;
    readonly routeKey: string | undefined;
  } | null>(null);
  // Without a column the inspector is a sheet, opened only on request for the route on top, and
  // shown again when that route returns to the top.
  const [inspectorSheetRoute, setInspectorSheetRoute] = useState<string | null>(null);
  const inspectorActive = workspaceInspector?.active ?? false;
  // Android's split content is a rounded card: keep it off the screen edge like the list card.
  const contentEndGap = Platform.OS === "android" && layout.usesSplitView ? 4 : 0;
  // The panes with the sidebar open and no keyboard, so typing can't feed back into whether it fits.
  const sidebarOpenPanes = useMemo(
    () =>
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: width,
        horizontalSafeArea,
        nativeWorkspace,
        primarySidebarFloats: sidebarFloats,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible:
          !workspacePage && inspectorActive && fileInspectorPreferredVisible,
        auxiliaryPanePreferredWidth: fileInspectorPreferredWidth ?? undefined,
        nativeInspectorWidth,
      }),
    [
      nativeInspectorWidth,
      horizontalSafeArea,
      fileInspectorPreferredVisible,
      fileInspectorPreferredWidth,
      inspectorActive,
      layout,
      nativeWorkspace,
      sidebarFloats,
      width,
      workspacePage,
    ],
  );
  const sidebarCrowdsComposer =
    sidebarFloats || !chatFitsBesideSidebar(sidebarOpenPanes, contentEndGap);
  const keyboardTakesSidebar = composerKeyboardActive && sidebarCrowdsComposer;
  const showPrimarySidebar =
    sidebarWithoutKeyboard && (primarySidebarPinned || !keyboardTakesSidebar);
  // While the composer edits, the sidebar's width follows the keyboard's own progress, so it
  // leaves and returns in step with the keyboard instead of on a timer of its own.
  const keyboardHoldsSidebar =
    Platform.OS === "android" &&
    baseLayout.usesSplitView &&
    !workspacePage &&
    !primarySidebarPinned &&
    !sidebarFloats &&
    sidebarCrowdsComposer &&
    (composerEditing || composerKeyboardActive);
  const fileInspector = useMemo(
    () =>
      deriveFileInspectorPaneLayout({
        layout,
        viewportWidth: width,
        preferredWidth: fileInspectorPreferredWidth ?? undefined,
        reservedLeadingWidth:
          shouldRenderPrimarySidebar && showPrimarySidebar && !sidebarFloats
            ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0)
            : 0,
      }),
    [
      fileInspectorPreferredWidth,
      layout,
      showPrimarySidebar,
      shouldRenderPrimarySidebar,
      sidebarFloats,
      width,
    ],
  );
  const inspectorSheetOpen =
    !fileInspector.supported &&
    !workspacePage &&
    inspectorSheetRoute !== null &&
    workspaceInspector?.active === true &&
    workspaceInspector.routeKey === inspectorSheetRoute;
  const panes = useMemo(
    () =>
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: width,
        horizontalSafeArea,
        nativeWorkspace,
        primarySidebarFloats: sidebarFloats,
        primarySidebarPreferredVisible: showPrimarySidebar,
        // Only a column a screen fills makes room, so a stale preference can't hide the sidebar.
        auxiliaryPanePreferredVisible:
          !workspacePage && inspectorActive && fileInspectorPreferredVisible,
        auxiliaryPanePreferredWidth: fileInspectorPreferredWidth ?? undefined,
        nativeInspectorWidth,
      }),
    [
      nativeInspectorWidth,
      horizontalSafeArea,
      fileInspectorPreferredVisible,
      fileInspectorPreferredWidth,
      inspectorActive,
      layout,
      nativeWorkspace,
      showPrimarySidebar,
      sidebarFloats,
      width,
      workspacePage,
    ],
  );
  // Whether the sidebar is open once the keyboard is gone; the keyboard's progress scales it.
  const sidebarRestsOpen = sidebarWithoutKeyboard && sidebarOpenPanes.primarySidebarVisible;
  // Routes still on the stack remember their reveal, so going back to one keeps the user's choice.
  const revealedInspectors = useRef<ReadonlyMap<string, string>>(new Map());
  const workspaceInspectorOwner = useRef<symbol | null>(null);
  const registerWorkspaceInspector = (
    content: InspectorContent,
    routeKey: string | undefined,
    revealKey?: string,
  ) => {
    const owner = Symbol("workspace-inspector");
    workspaceInspectorOwner.current = owner;
    setWorkspaceInspector({ content, active: true, routeKey });
    if (
      routeKey !== undefined &&
      revealKey !== undefined &&
      revealedInspectors.current.get(routeKey) !== revealKey
    ) {
      const state = rootStackState(navigation);
      const live = new Set(state?.routes.slice(0, state.index + 1).map((route) => route.key));
      revealedInspectors.current = new Map(
        [...revealedInspectors.current, [routeKey, revealKey] as const].filter(
          ([key]) => live.has(key) || key === routeKey,
        ),
      );
      setFileInspectorPreferredVisible(true);
    }

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
  const setPrimarySidebarVisible = (visible: boolean) => {
    if (layout.variant === "medium") {
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
    if (keyboardTakesSidebar) {
      void KeyboardController.dismiss();
      if (preferredSidebarVisible) return;
    }
    if (!panes.primarySidebarVisible && panes.primarySidebarSuppressedByAuxiliary) {
      setFileInspectorPreferredVisible(false);
      setPrimarySidebarPreferredVisible(true);
      return;
    }
    setPrimarySidebarVisible(!preferredSidebarVisible);
  };
  const revealPrimarySidebar = () => {
    if (keyboardTakesSidebar) void KeyboardController.dismiss();
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
  // Resizing into a column closes the sheet without this, so the inspector moves into the column.
  const dismissInspectorSheet = () => {
    setFileInspectorPreferredVisible(false);
    setInspectorSheetRoute(null);
  };
  const showInspector = () => {
    setFileInspectorPreferredVisible(true);
    if (fileInspector.supported) {
      setInspectorSheetRoute(null);
      return;
    }
    const state = rootStackState(navigation);
    const top = workspaceRoutesOf(state?.routes.slice(0, state.index + 1) ?? []).workspace.at(-1);
    setInspectorSheetRoute(top?.key ?? null);
  };
  const handleOpenFilesCommand = () => {
    const activeThread = parseActiveThreadPath(pathname);
    if (!layout.usesSplitView || !fileInspector.supported || activeThread === null) {
      return false;
    }
    showInspector();
    if (props.workspaceRouteName === "ThreadFiles" || props.workspaceRouteName === "ThreadFile") {
      return true;
    }
    navigation.navigate("ThreadFiles", activeThread);
    return true;
  };
  useHardwareKeyboardCommand("files", handleOpenFilesCommand);
  const toggleAuxiliaryPane = () => {
    if (fileInspector.supported) {
      setFileInspectorPreferredVisible((current) => !current);
      setInspectorSheetRoute(null);
    } else if (inspectorSheetOpen) dismissInspectorSheet();
    else showInspector();
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
        seedPullRequest: withKnownPullRequestSummary,
      },
    );
    if (layout.variant === "medium") {
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
      setInspectorSheetRoute(null);
      if (layout.variant === "medium") setPrimarySidebarVisible(false);
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

  const inspectorColumnTargetWidth = panes.auxiliaryPaneVisible
    ? (panes.auxiliaryPaneWidth ?? 0)
    : 0;
  // Android's split is one strip: a sidebar slot of fixed width, then the detail pane. The
  // sidebar never resizes; both slide by one offset, so together they always fill the width.
  // The pane spans the sidebar's room too unless the sidebar has finished arriving: a sidebar on
  // its way in pushes the wide pane past the edge, and one leaving uncovers it.
  const stripSidebar =
    Platform.OS === "android" &&
    layout.usesSplitView &&
    layout.listPaneWidth !== null &&
    !workspacePage &&
    !sidebarFloats;
  const sidebarSlotWidth = (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0);
  const sidebarTargetOpen = keyboardHoldsSidebar ? sidebarRestsOpen : panes.primarySidebarVisible;
  const [sidebarMotion, setSidebarMotion] = useState({
    strip: stripSidebar,
    settledOpen: sidebarTargetOpen,
  });
  if (sidebarMotion.strip !== stripSidebar) {
    // Entering or leaving the strip (a workspace page, a fold) snaps the sidebar into place.
    setSidebarMotion({ strip: stripSidebar, settledOpen: sidebarTargetOpen });
  } else if (sidebarMotion.settledOpen && !sidebarTargetOpen) {
    setSidebarMotion({ strip: stripSidebar, settledOpen: false });
  }
  const sidebarSettledOpen =
    sidebarMotion.strip === stripSidebar ? sidebarMotion.settledOpen : sidebarTargetOpen;
  const markSidebarSettled = (open: boolean) =>
    setSidebarMotion((current) =>
      current.settledOpen === open ? current : { ...current, settledOpen: open },
    );
  // The keyboard covers the sidebar's share from the moment it starts showing until it is gone.
  const contentSpansSidebar =
    stripSidebar &&
    (!sidebarSettledOpen || !sidebarTargetOpen || (keyboardHoldsSidebar && keyboardOnScreen));
  const contentTargetWidth = !layout.usesSplitView
    ? null
    : Math.max(
        0,
        (contentSpansSidebar ? width : panes.contentPaneWidth) -
          inspectorColumnTargetWidth -
          contentEndGap,
      );
  // A workspace page (Usage) lays out at this width even while hidden behind another tab, so
  // opening it widens nothing it measured.
  const workspacePageWidth = !layout.usesSplitView
    ? null
    : workspacePage
      ? contentTargetWidth
      : Math.max(
          0,
          viewportWidth -
            (shouldRenderNavigationRail ? ANDROID_WORKSPACE_RAIL_WIDTH : 0) -
            contentEndGap,
        );
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
  const contentLeftTarget = sidebarFloats
    ? 0
    : navigationRailWidth +
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
  const keyboardHold = useSharedValue(keyboardHoldsSidebar);
  const leavingWorkspacePage = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- animates the Reanimated rail and sidebar width shared values toward the layout's targets
  useEffect(() => {
    if (nativeWorkspace) return;
    // Released mid-keyboard (the composer blurred), the timing starts where the sidebar is drawn.
    if (keyboardHold.get() && !keyboardHoldsSidebar) {
      renderedSidebarWidth.set(renderedSidebarWidth.get() * (1 - keyboardProgress.get()));
    }
    keyboardHold.set(keyboardHoldsSidebar);
    renderedRailWidth.set(withTiming(navigationRailWidth, WORKSPACE_PANE_TIMING));
    // A workspace page hides the sidebar through React instead, in the same commit that mounts
    // the page. Animating it here would hide it a few frames before the page appears.
    if (workspacePage) {
      leavingWorkspacePage.current = true;
      return;
    }
    const snap = leavingWorkspacePage.current;
    leavingWorkspacePage.current = false;
    const targetWidth = (keyboardHoldsSidebar ? sidebarRestsOpen : panes.primarySidebarVisible)
      ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0)
      : 0;
    // The content beside it already took its final width when the page closed.
    renderedSidebarWidth.set(
      withTiming(targetWidth, snap ? { duration: 0 } : WORKSPACE_PANE_TIMING, (finished) => {
        if (finished && Platform.OS === "android") {
          runOnJS(settleListPane)(listPaneRevision);
          runOnJS(markSidebarSettled)(targetWidth > 0);
        }
      }),
    );
  }, [
    nativeWorkspace,
    navigationRailWidth,
    layout.listPaneWidth,
    layout.listPaneGap,
    panes.primarySidebarVisible,
    keyboardHoldsSidebar,
    keyboardHold,
    keyboardProgress,
    sidebarRestsOpen,
    renderedSidebarWidth,
    renderedRailWidth,
    settleListPane,
    markSidebarSettled,
    listPaneRevision,
    workspacePage,
  ]);
  const railAnimatedStyle = useAnimatedStyle(() => ({ width: renderedRailWidth.value }));
  const floatingSidebarAnimatedStyle = useAnimatedStyle(() => ({ left: renderedRailWidth.value }));
  const floatingSidebarOpen = sidebarFloats && panes.primarySidebarVisible;
  // Its own value, so a sidebar that was beside a list doesn't dim the page as it leaves.
  const scrimOpacity = useSharedValue(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- animates the Reanimated scrim with the floating sidebar
  useEffect(() => {
    scrimOpacity.set(withTiming(floatingSidebarOpen ? 0.32 : 0, WORKSPACE_PANE_TIMING));
  }, [floatingSidebarOpen, scrimOpacity]);
  const scrimAnimatedStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Back closes a floating sidebar before it leaves the page
  useEffect(() => {
    if (!floatingSidebarOpen || nativeWorkspace) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // A sheet or modal over the workspace takes Back first.
      const state = rootStackState(navigation);
      if (state && workspaceRoutesOf(state.routes.slice(0, state.index + 1)).overlays.length > 0) {
        return false;
      }
      setPrimarySidebarVisible(false);
      return true;
    });
    return () => subscription.remove();
  }, [floatingSidebarOpen, nativeWorkspace, navigation, setPrimarySidebarVisible]);
  // Showing or hiding the sidebar clips a fixed-width list. A hinge resize instead tracks the
  // animated edge, so the header actions slide with it rather than jumping or being covered.
  const listPaneGap = layout.listPaneGap ?? 0;
  const keyboardSidebarRest = sidebarRestsOpen
    ? (layout.listPaneWidth ?? 0) + (layout.listPaneGap ?? 0)
    : 0;
  const drawnSidebarWidth = useDerivedValue(
    () => renderedSidebarWidth.value * (keyboardHold.value ? 1 - keyboardProgress.value : 1),
  );
  const listPaneAnimatedStyle = useAnimatedStyle(() => ({
    width: Math.min(
      listPaneCeiling,
      Math.max(
        listPaneFloor,
        (stripSidebar ? sidebarSlotWidth : drawnSidebarWidth.value) - listPaneGap,
      ),
    ),
  }));
  // How far the strip has slid: 0 with the sidebar shown, minus its width with it gone.
  const stripOffset = useDerivedValue(() =>
    stripSidebar ? drawnSidebarWidth.value - sidebarSlotWidth : 0,
  );
  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    // Fading a UIKit glass ancestor can leave remounted header effects missing.
    opacity:
      stripSidebar || Platform.OS === "ios" || floatingTabsEnabled
        ? 1
        : Math.min(1, drawnSidebarWidth.value / 80),
    width: stripSidebar ? sidebarSlotWidth : drawnSidebarWidth.value,
    flexShrink: stripSidebar ? 0 : 1,
    transform: [{ translateX: stripOffset.value }],
  }));
  // The content keeps the width React laid it out at and rides the sidebar's edge, so a keyboard
  // transition relays nothing out per frame, the way UIKit animates the iOS split view.
  // Until React commits the wider layout, the detail card continues past its right edge, so the
  // strip the narrower column leaves shows the card instead of the row behind it.
  const contentOverhangStyle = useAnimatedStyle(() => ({
    opacity: keyboardHold.value && keyboardProgress.value > 0 ? 1 : 0,
  }));
  const threadHeader = useToolbarLayout(false, composerKeyboardActive);
  const threadHeaderHeight =
    threadHeader.paddingTop + threadHeader.height + threadHeader.paddingBottom;

  // Clip the navigator at its settled width so native headers and markdown reflow only once per pane toggle.
  const renderedInspectorWidth = useSharedValue(inspectorColumnTargetWidth);
  const renderedContentWidth = useDerivedValue(() =>
    Math.max(
      0,
      viewportWidth -
        (sidebarFloats ? 0 : renderedRailWidth.value) -
        (workspacePage || sidebarFloats ? 0 : drawnSidebarWidth.value) -
        renderedInspectorWidth.value,
    ),
  );
  // Android can resize the native row before React removes its split panes on a fold.
  const androidSplit = Platform.OS === "android" && layout.usesSplitView;
  // In the strip the column itself slides with the sidebar: Android only delivers touches inside a
  // parent's bounds, so content may not slide out of its column. Every branch sets every key:
  // Reanimated keeps a key a branch drops, so a fold mid-slide would leave the column shifted.
  const androidContentSlotStyle = useAnimatedStyle(() =>
    !androidSplit
      ? { width: "100%" as const, marginRight: 0, transform: [{ translateX: 0 }] }
      : stripSidebar
        ? {
            // Wide enough for the pane at either width; the margin gives the sidebar's share
            // back to the row, so a column after it stays put while the strip slides.
            width: Math.max(
              0,
              viewportWidth - renderedRailWidth.value - renderedInspectorWidth.value,
            ),
            marginRight: -sidebarSlotWidth,
            transform: [{ translateX: stripOffset.value }],
          }
        : { width: renderedContentWidth.value, marginRight: 0, transform: [{ translateX: 0 }] },
  );
  // While the sidebar animates, clip the settled navigator instead of reflowing its text every frame.
  // In the strip it lifts entirely: the content outgrows its column, and a cap that follows
  // React's width would clip the wider layout for the frame it lands.
  const androidNavigatorLimit = useAnimatedStyle(() => ({
    maxWidth: stripSidebar
      ? viewportWidth
      : androidSplit &&
          contentTargetWidth !== null &&
          renderedContentWidth.value < contentTargetWidth
        ? contentTargetWidth
        : ("100%" as const),
  }));

  // Rotating flips the overlay; until the new size reaches JS, predict the reset above.
  const sidebarOverRotates =
    nativeWorkspace && nativeMetrics?.hasHinge === true && layout.usesSplitView;
  // The current orientation's panes already account for an inspector that needs the sidebar's room.
  const sidebarInLandscape =
    baseLayout.variant === "medium"
      ? primarySidebarPinned || primarySidebarPreferredVisible
      : panes.primarySidebarVisible;
  const sidebarInPortrait =
    primarySidebarPinned ||
    (baseLayout.variant === "medium" ? overlaySidebar.visible : isWorkspaceListPath(pathname));
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
    registerWorkspaceInspector,
    setPrimarySidebarSearchQuery,
    showInspector,
    toggleAuxiliaryPane,
    sidebarToggleable: layout.usesSplitView && !primarySidebarPinned && !workspacePage,
    togglePrimarySidebar,
    revealPrimarySidebar,
    setPrimarySidebarVisible,
    openWorkspaceTab,
    setAuxiliaryPaneWidth: setFileInspectorPreferredWidth,
    nativeInspectorWidth,
    setNativeInspectorWidth: (width: number) =>
      setNativeInspectorWidthFraction(inspectorWidthFor(width / viewportWidth) / viewportWidth),
    composerKeyboardActive,
    keyboardHoldsSidebar,
    setComposerEditing,
    sidebarByOrientation,
    workspacePageWidth,
  };

  const inspectorSheet = (
    <WorkspaceInspectorSheet
      open={inspectorSheetOpen}
      onClose={dismissInspectorSheet}
      content={workspaceInspector?.content}
    />
  );
  if (nativeWorkspace) {
    return (
      <HomeListOptionsProvider
        projectGroupingMode={projectGroupingMode}
        savedFilters={props.savedThreadListFilters}
      >
        <AdaptiveWorkspaceContext value={contextValue}>
          <NativeWorkspaceInspectorContext
            value={{
              // Without a column the sheet shows it; the hidden native column must not mount it too.
              content: fileInspector.supported ? workspaceInspector?.content : undefined,
              visible: inspectorColumnTargetWidth > 0,
            }}
          >
            {props.children}
            {inspectorSheet}
          </NativeWorkspaceInspectorContext>
        </AdaptiveWorkspaceContext>
      </HomeListOptionsProvider>
    );
  }
  const renderColumns = (children: ReactNode, sidebar?: ReactNode) => (
    <View
      testID="adaptive-workspace-layout"
      className={Platform.OS === "android" ? "flex-1 flex-row bg-header" : "flex-1 flex-row"}
    >
      <AndroidHingeObserver onChange={handleHingeChange} />
      {shouldRenderNavigationRail ? (
        <Animated.View
          className={sidebarFloats ? "absolute inset-y-0 left-0" : "shrink self-stretch"}
          style={railAnimatedStyle}
        />
      ) : null}
      {shouldRenderPrimarySidebar && layout.listPaneWidth !== null ? (
        <Animated.View
          className="self-stretch overflow-hidden android:shrink"
          accessibilityElementsHidden={workspacePage || !panes.primarySidebarVisible}
          collapsable={false}
          importantForAccessibility={
            !workspacePage && panes.primarySidebarVisible ? "auto" : "no-hide-descendants"
          }
          pointerEvents={!workspacePage && panes.primarySidebarVisible ? "auto" : "none"}
          // Under a workspace page the sidebar leaves the row but keeps its size, so its
          // lists never lay out at zero size and are ready, unchanged, on the way back. The
          // content pane, laid out after it, covers it, in the same mount as the page.
          style={[
            workspacePage ? { position: "absolute", top: 0, bottom: 0, left: 0 } : null,
            sidebarFloats
              ? [
                  { position: "absolute", top: 0, bottom: 0, zIndex: 2, elevation: 8 },
                  floatingSidebarAnimatedStyle,
                ]
              : null,
            sidebarAnimatedStyle,
          ]}
        >
          <Animated.View className="flex-1" style={listPaneAnimatedStyle}>
            <PaneContext value="sidebar">
              <RenderErrorBoundary
                renderFallback={(fallback) => (
                  <RenderFailureView
                    {...fallback}
                    title="The sidebar couldn't be displayed"
                    exit={{ label: "Open settings", onPress: handleOpenSettings }}
                  />
                )}
              >
                {/* Without a sidebar route (iPadOS before 26) the columns draw the thread list. */}
                {sidebar ?? <WorkspaceThreadSidebar />}
              </RenderErrorBoundary>
            </PaneContext>
            {/* Keep the pill under the content throughout the sidebar's clipping animation. */}
            {floatingTabsEnabled && !workspacePage ? (
              <FloatingWorkspaceTabs
                paneWidth={layout.listPaneWidth}
                onNewThread={handleStartNewTask}
                onSelect={revealPrimarySidebar}
              />
            ) : null}
          </Animated.View>
        </Animated.View>
      ) : null}
      <Animated.View
        className={
          Platform.OS === "android"
            ? "max-w-full shrink-0 overflow-hidden bg-header"
            : "flex-1 overflow-hidden bg-screen"
        }
        style={Platform.OS === "android" ? androidContentSlotStyle : undefined}
        collapsable={false}
        importantForAccessibility={floatingSidebarOpen ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={floatingSidebarOpen}
      >
        <Animated.View
          collapsable={false}
          style={[
            contentTargetWidth !== null
              ? {
                  flex: 1,
                  width: contentTargetWidth,
                  // The strip's column is wider than the pane; the pane sits at its start.
                  alignSelf: contentAnchor.end && !stripSidebar ? "flex-end" : "flex-start",
                  marginRight: contentAnchor.end && !stripSidebar ? contentEndGap : 0,
                }
              : { flex: 1 },
            Platform.OS === "android" ? androidNavigatorLimit : undefined,
          ]}
        >
          {/* Android holds the content still, so its floating controls keep its width. */}
          <WorkspaceContentWidthContext
            value={layout.usesSplitView && Platform.OS !== "android" ? renderedContentWidth : null}
          >
            <WorkspaceSettledContentWidthContext
              value={Platform.OS === "android" && layout.usesSplitView ? contentTargetWidth : null}
            >
              {/* Compact Settings keeps the bottom navigation under all of its pages. */}
              <SafeAreaInsetsContext
                value={
                  floatingTabsEnabled &&
                  (compactAndroidSettings || (layout.usesSplitView && workspacePage))
                    ? {
                        ...safeAreaInsets,
                        bottom:
                          safeAreaInsets.bottom +
                          FLOATING_TABS.bottom +
                          FLOATING_TABS.edge +
                          floatingTabs.height,
                      }
                    : compactAndroidSettings
                      ? { ...safeAreaInsets, bottom: 0 }
                      : safeAreaInsets
                }
              >
                <View className="flex-1">
                  <PaneContext value="content">
                    <SettingsWorkspaceLayout>{children}</SettingsWorkspaceLayout>
                  </PaneContext>
                </View>
              </SafeAreaInsetsContext>
              {floatingTabsEnabled &&
              (compactAndroidSettings || (layout.usesSplitView && workspacePage)) ? (
                <FloatingWorkspaceTabs
                  paneWidth={layout.usesSplitView ? (layout.listPaneWidth ?? undefined) : undefined}
                  fillWidth={compactAndroidSettings}
                  onNewThread={handleStartNewTask}
                />
              ) : compactAndroidSettings ? (
                <AndroidWorkspaceNavigation onNewThread={handleStartNewTask} />
              ) : null}
            </WorkspaceSettledContentWidthContext>
          </WorkspaceContentWidthContext>
        </Animated.View>
        {keyboardHoldsSidebar && contentTargetWidth !== null ? (
          <>
            <Animated.View
              pointerEvents="none"
              className="absolute top-0 bg-header"
              style={[
                {
                  left: contentTargetWidth,
                  width: keyboardSidebarRest + contentEndGap,
                  height: threadHeaderHeight,
                },
                contentOverhangStyle,
              ]}
            />
            <Animated.View
              pointerEvents="none"
              className="absolute bottom-0 rounded-tr-[28px] bg-thread-canvas"
              style={[
                {
                  // Starts under the card's rounded corner so the two read as one card.
                  left: contentTargetWidth - 28,
                  width: keyboardSidebarRest + 28,
                  top: threadHeaderHeight,
                },
                contentOverhangStyle,
              ]}
            />
          </>
        ) : null}
      </Animated.View>
      {sidebarFloats ? (
        <Animated.View
          className="absolute inset-0 bg-black"
          pointerEvents={floatingSidebarOpen ? "auto" : "none"}
          style={[{ zIndex: 1 }, scrimAnimatedStyle]}
        >
          <Pressable
            accessibilityLabel="Hide sidebar"
            className="flex-1"
            onPress={() => setPrimarySidebarVisible(false)}
          />
        </Animated.View>
      ) : null}
      <PaneContext value="inspector">
        <WorkspaceInspectorPane
          renderedInspectorWidth={renderedInspectorWidth}
          active={workspaceInspector?.active ?? false}
          panes={panes}
          content={workspaceInspector?.content}
          setAuxiliaryPaneWidth={setFileInspectorPreferredWidth}
          onClose={() => setFileInspectorPreferredVisible(false)}
          onClosed={handleWorkspaceInspectorClosed}
        />
      </PaneContext>
      {inspectorSheet}
      {shouldRenderNavigationRail && navigationRailWidth > 0 ? (
        // Its trailing inset clips the old rail as soon as Android fits the workspace to a cover display.
        <View
          className="absolute inset-y-0 left-0 overflow-hidden"
          style={[
            railOverlay
              ? { right: 0 }
              : { right: viewportWidth - navigationRailWidth, maxWidth: navigationRailWidth },
            sidebarFloats ? { zIndex: 3, elevation: 8 } : null,
          ]}
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
  );

  return (
    <HomeListOptionsProvider
      projectGroupingMode={projectGroupingMode}
      savedFilters={props.savedThreadListFilters}
    >
      <AdaptiveWorkspaceContext.Provider value={contextValue}>
        <WindowHingeContext value={windowHinge}>
          {usesPresentationHost ? (
            <WorkspaceColumnsRendererContext value={renderColumns}>
              {props.children}
            </WorkspaceColumnsRendererContext>
          ) : (
            renderColumns(props.children)
          )}
        </WindowHingeContext>
      </AdaptiveWorkspaceContext.Provider>
    </HomeListOptionsProvider>
  );
}
