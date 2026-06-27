import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useFocusEffect, useGlobalSearchParams, usePathname, useRouter } from "expo-router";
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
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

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
import { buildThreadFilesNavigation, buildThreadRoutePath } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  parseActiveThreadPath,
  useHardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { HomeListOptionsProvider } from "../home/home-list-options";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";

interface AdaptiveWorkspaceContextValue {
  readonly layout: Layout;
  readonly panes: WorkspacePaneLayout;
  readonly fileInspector: FileInspectorPaneLayout;
  readonly activateAuxiliaryPaneRole: (role: WorkspaceAuxiliaryPaneRole) => () => void;
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
  activateAuxiliaryPaneRole: () => () => undefined,
  showAuxiliaryPane: () => undefined,
  toggleAuxiliaryPane: () => undefined,
  togglePrimarySidebar: () => undefined,
  setAuxiliaryPaneWidth: () => undefined,
});

function firstRouteParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export function useAdaptiveWorkspaceLayout(): AdaptiveWorkspaceContextValue {
  return use(AdaptiveWorkspaceContext);
}

export function useAdaptiveWorkspacePaneRole(role: WorkspaceAuxiliaryPaneRole) {
  const { activateAuxiliaryPaneRole } = useAdaptiveWorkspaceLayout();

  useFocusEffect(
    useCallback(() => activateAuxiliaryPaneRole(role), [activateAuxiliaryPaneRole, role]),
  );
}

export function AdaptiveWorkspaceLayout(props: { readonly children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const pathname = usePathname();
  const router = useRouter();
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
  const [focusedAuxiliaryPaneRole, setFocusedAuxiliaryPaneRole] =
    useState<WorkspaceAuxiliaryPaneRole | null>(null);
  const params = useGlobalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const baseLayout = useMemo(() => deriveLayout({ width, height }), [height, width]);
  const layout = baseLayout;
  const fileInspector = useMemo(
    () =>
      deriveFileInspectorPaneLayout({
        layout,
        viewportWidth: width,
        preferredWidth: fileInspectorPreferredWidth ?? undefined,
        reservedLeadingWidth:
          layout.usesSplitView && primarySidebarPreferredVisible ? (layout.listPaneWidth ?? 0) : 0,
      }),
    [fileInspectorPreferredWidth, layout, primarySidebarPreferredVisible, width],
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
  const environmentId = firstRouteParam(params.environmentId);
  const threadId = firstRouteParam(params.threadId);
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
    router.replace(buildThreadFilesNavigation(activeThread));
    return true;
  }, [fileInspector.supported, layout.usesSplitView, pathname, router, showAuxiliaryPane]);
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
      activateAuxiliaryPaneRole,
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
      showAuxiliaryPane,
      setAuxiliaryPaneWidth,
      toggleAuxiliaryPane,
      togglePrimarySidebar,
    ],
  );

  const handleOpenSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);
  const handleStartNewTask = useCallback(() => {
    router.push("/new");
  }, [router]);

  const renderedSidebarWidth = useSharedValue(
    panes.primarySidebarVisible ? (layout.listPaneWidth ?? 0) : 0,
  );
  useEffect(() => {
    const targetWidth = panes.primarySidebarVisible ? (layout.listPaneWidth ?? 0) : 0;
    renderedSidebarWidth.value = withTiming(targetWidth, {
      duration: panes.primarySidebarVisible ? 220 : 160,
      easing: panes.primarySidebarVisible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [layout.listPaneWidth, panes.primarySidebarVisible, renderedSidebarWidth]);
  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, renderedSidebarWidth.value / 80),
    width: renderedSidebarWidth.value,
  }));

  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      const destination = buildThreadRoutePath(thread);
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
        router.setParams({
          environmentId: String(thread.environmentId),
          threadId: String(thread.id),
        });
        return;
      }
      if (navigationAction === "replace") {
        setFileInspectorPreferredVisible(false);
        router.replace(destination);
        return;
      }
      router.push(destination);
    },
    [layout.usesSplitView, pathname, router, selectedThreadKey],
  );

  return (
    <HomeListOptionsProvider>
      <AdaptiveWorkspaceContext.Provider value={contextValue}>
        <View testID="adaptive-workspace-layout" style={{ flex: 1, flexDirection: "row" }}>
          {layout.usesSplitView && layout.listPaneWidth !== null ? (
            <Animated.View
              accessibilityElementsHidden={!panes.primarySidebarVisible}
              collapsable={false}
              importantForAccessibility={
                panes.primarySidebarVisible ? "auto" : "no-hide-descendants"
              }
              pointerEvents={panes.primarySidebarVisible ? "auto" : "none"}
              style={[{ alignSelf: "stretch", overflow: "hidden" }, sidebarAnimatedStyle]}
            >
              <ThreadNavigationSidebar
                width={layout.listPaneWidth}
                visible={panes.primarySidebarVisible}
                onRequestVisibility={revealPrimarySidebar}
                selectedThreadKey={selectedThreadKey}
                onOpenSettings={handleOpenSettings}
                onSelectThread={handleSelectThread}
                onStartNewTask={handleStartNewTask}
              />
            </Animated.View>
          ) : null}
          <View collapsable={false} style={{ flex: 1 }}>
            {props.children}
          </View>
        </View>
      </AdaptiveWorkspaceContext.Provider>
    </HomeListOptionsProvider>
  );
}
