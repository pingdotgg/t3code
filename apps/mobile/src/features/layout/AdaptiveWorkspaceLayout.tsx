import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useFocusEffect } from "@react-navigation/native";
import {
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
import { useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import {
  deriveFileInspectorPaneLayout,
  deriveLayout,
  deriveWorkspacePaneLayout,
  type FileInspectorPaneLayout,
  type Layout,
  type WorkspaceAuxiliaryPaneRole,
  type WorkspacePaneLayout,
} from "../../lib/layout";
import { resolveThreadSelectionNavigationAction } from "../../lib/adaptive-navigation";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  parseActiveThreadPath,
  useHardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { HomeListOptionsProvider } from "../home/home-list-options";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspaceInspectorPane } from "./workspace-inspector-pane";

interface AdaptiveWorkspaceContextValue {
  readonly layout: Layout;
  readonly panes: WorkspacePaneLayout;
  readonly fileInspector: FileInspectorPaneLayout;
  readonly primarySidebarSearchQuery: string;
  readonly activateAuxiliaryPaneRole: (role: WorkspaceAuxiliaryPaneRole) => () => void;
  /**
   * Route screens hand their inspector pane content to the workspace so it
   * renders BESIDE the navigator (outside the native stack header) instead of
   * inside the route. Returns a deactivate callback: the pane animates closed
   * (content kept mounted for the exit transition) unless a newer
   * registration already took over — stale deactivates never clobber it.
   * Prefer useRegisterWorkspaceInspector over calling this directly.
   */
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
 * Register this screen's inspector pane content with the workspace column.
 *
 * The column renders BESIDE the navigator — outside any screen — so the
 * registering screen's navigation and route contexts are captured here and
 * re-provided around the portal content. Without them, useNavigation/useRoute
 * inside the pane (e.g. GitOverviewSheet via useThreadSelection) throw
 * "Couldn't find a route object".
 *
 * Registration is FOCUS-scoped, driven by navigation events rather than the
 * screen's own render cycle: react-native-screens freezes blurred screens, so
 * a cleanup that depends on the blurred subtree re-rendering never runs and
 * would leak the pane into the next route. Blur deactivates the pane (it
 * animates closed, or is replaced seamlessly when the next route registers in
 * the same commit); focus re-registers it.
 */
export function useRegisterWorkspaceInspector(render: (() => ReactNode) | undefined) {
  const { registerWorkspaceInspector } = useAdaptiveWorkspaceLayout();
  // Raw context values (not the useNavigation/useRoute wrappers) so the
  // portal re-provides exactly what this screen sees.
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

  // Focus lifecycle. Blur/focus events fire even when the blurred subtree is
  // frozen (events are navigation-driven, renders are not).
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

  // Content changes while focused re-register in place.
  useEffect(() => {
    if (focusedRef.current) {
      syncRegistration();
    }
  }, [syncRegistration, wrappedRender]);

  // Unmount: hand the pane back (owner-guarded, so a route that already
  // took over is unaffected).
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
}) {
  const { width, height } = useWindowDimensions();
  const pathname = props.pathname;
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
  const [focusedAuxiliaryPaneRole, setFocusedAuxiliaryPaneRole] =
    useState<WorkspaceAuxiliaryPaneRole | null>(null);
  const baseLayout = useMemo(() => deriveLayout({ width, height }), [height, width]);
  const layout = baseLayout;
  // In split layouts the sidebar IS the thread list — it renders on every
  // route, including Home (which shows an empty-detail pane instead of the
  // compact list).
  const shouldRenderPrimarySidebar = layout.usesSplitView;
  const fileInspector = useMemo(
    () =>
      deriveFileInspectorPaneLayout({
        layout,
        viewportWidth: width,
        preferredWidth: fileInspectorPreferredWidth ?? undefined,
        reservedLeadingWidth:
          shouldRenderPrimarySidebar && primarySidebarPreferredVisible
            ? (layout.listPaneWidth ?? 0)
            : 0,
      }),
    [
      fileInspectorPreferredWidth,
      layout,
      primarySidebarPreferredVisible,
      shouldRenderPrimarySidebar,
      width,
    ],
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
        primarySidebarPreferredVisible,
        auxiliaryPanePreferredVisible,
        auxiliaryPaneRole,
        auxiliaryPanePreferredWidth: auxiliaryPanePreferredWidth ?? undefined,
      }),
    [
      auxiliaryPanePreferredVisible,
      auxiliaryPaneRole,
      auxiliaryPanePreferredWidth,
      layout,
      primarySidebarPreferredVisible,
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
  // Wrapped in an object: bare functions in useState would be treated as
  // lazy initializers/updaters. `active: false` keeps the outgoing route's
  // content mounted so the pane can animate closed (or be replaced
  // seamlessly by the next route's registration in the same commit).
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
  // Once the close animation settles, drop the stale content entirely.
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
    if (!panes.primarySidebarVisible && panes.primarySidebarSuppressedByAuxiliary) {
      setFileInspectorPreferredVisible(false);
      setPrimarySidebarPreferredVisible(true);
      return;
    }
    setPrimarySidebarPreferredVisible((current) => !current);
  }, [panes.primarySidebarSuppressedByAuxiliary, panes.primarySidebarVisible]);
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
  useHardwareKeyboardCommand("toggleSidebar", handleToggleSidebarCommand);
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
  const contextValue = useMemo(
    () => ({
      layout,
      panes,
      fileInspector,
      primarySidebarSearchQuery,
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

  const handleOpenSettings = useCallback(() => {
    navigation.navigate("SettingsSheet", { screen: "Settings" });
  }, [navigation]);

  // Minted here (root stack navigation) so the sidebar pane stays free of
  // navigation hooks — on iOS it renders inside an independent nav tree.
  const handleOpenEnvironmentSettings = useCallback(() => {
    navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" });
  }, [navigation]);

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

  const renderedSidebarWidth = useSharedValue(
    panes.primarySidebarVisible ? (layout.listPaneWidth ?? 0) : 0,
  );
  useEffect(() => {
    const targetWidth = panes.primarySidebarVisible ? (layout.listPaneWidth ?? 0) : 0;
    renderedSidebarWidth.value = withTiming(targetWidth, WORKSPACE_PANE_TIMING);
  }, [layout.listPaneWidth, panes.primarySidebarVisible, renderedSidebarWidth]);
  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, renderedSidebarWidth.value / 80),
    width: renderedSidebarWidth.value,
  }));

  // Freeze the content pane at its SETTLED width while the side panes
  // animate. The navigator (native header + markdown feed) lays out ONCE per
  // pane toggle instead of re-measuring on every animation frame — the
  // animating columns merely clip/reveal it over a matching background.
  // Continuously re-wrapping the chat feed was the main source of dropped
  // frames during sidebar/inspector transitions.
  const inspectorColumnTargetWidth =
    workspaceInspector !== null && workspaceInspector.active && panes.auxiliaryPaneVisible
      ? (panes.auxiliaryPaneWidth ?? 0)
      : 0;
  const contentSettledWidth = layout.usesSplitView
    ? Math.max(0, panes.contentPaneWidth - inspectorColumnTargetWidth)
    : null;

  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      const params = {
        environmentId: String(thread.environmentId),
        threadId: String(thread.id),
      };
      const navigationAction = resolveThreadSelectionNavigationAction({
        usesSplitView: layout.usesSplitView,
        pathname,
      });
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
    [layout.usesSplitView, pathname, navigation, selectedThreadKey],
  );

  return (
    <HomeListOptionsProvider>
      <AdaptiveWorkspaceContext.Provider value={contextValue}>
        <View testID="adaptive-workspace-layout" className="flex-1 flex-row">
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
              <ThreadNavigationSidebar
                width={layout.listPaneWidth}
                visible={panes.primarySidebarVisible}
                onRequestVisibility={revealPrimarySidebar}
                selectedThreadKey={selectedThreadKey}
                onOpenSettings={handleOpenSettings}
                onOpenEnvironmentSettings={handleOpenEnvironmentSettings}
                onNewThreadInProject={handleNewThreadInProject}
                onSelectThread={handleSelectThread}
                onSearchQueryChange={setPrimarySidebarSearchQuery}
                searchQuery={primarySidebarSearchQuery}
              />
            </Animated.View>
          ) : null}
          <View className="flex-1 overflow-hidden bg-screen" collapsable={false}>
            <View
              collapsable={false}
              style={
                contentSettledWidth !== null ? { flex: 1, width: contentSettledWidth } : { flex: 1 }
              }
            >
              {props.children}
            </View>
          </View>
          <WorkspaceInspectorPane
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
