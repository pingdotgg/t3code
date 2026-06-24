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
import { buildThreadRoutePath } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";
import { WORKSPACE_PANE_LAYOUT_TRANSITION } from "./workspace-pane-transition";

interface AdaptiveWorkspaceContextValue {
  readonly layout: Layout;
  readonly panes: WorkspacePaneLayout;
  readonly fileInspector: FileInspectorPaneLayout;
  readonly activateAuxiliaryPaneRole: (role: WorkspaceAuxiliaryPaneRole) => () => void;
  readonly showAuxiliaryPane: (role: WorkspaceAuxiliaryPaneRole) => void;
  readonly toggleAuxiliaryPane: () => void;
  readonly togglePrimarySidebar: () => void;
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
  const [fileInspectorPreferredVisible, setFileInspectorPreferredVisible] = useState(true);
  const [focusedAuxiliaryPaneRole, setFocusedAuxiliaryPaneRole] =
    useState<WorkspaceAuxiliaryPaneRole | null>(null);
  const sidebarProgress = useSharedValue(1);
  const params = useGlobalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const layout = useMemo(() => deriveLayout({ width, height }), [height, width]);
  const fileInspector = useMemo(
    () => deriveFileInspectorPaneLayout({ layout, viewportWidth: width }),
    [layout, width],
  );
  const auxiliaryPaneRole: WorkspaceAuxiliaryPaneRole =
    focusedAuxiliaryPaneRole ?? (/\/files(?:\/|$)/.test(pathname) ? "inspector" : "supplementary");
  const auxiliaryPanePreferredVisible =
    auxiliaryPaneRole === "inspector"
      ? fileInspectorPreferredVisible
      : supplementaryPanePreferredVisible;
  const panes = useMemo(
    () =>
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: width,
        primarySidebarPreferredVisible,
        auxiliaryPanePreferredVisible,
        auxiliaryPaneRole,
      }),
    [
      auxiliaryPanePreferredVisible,
      auxiliaryPaneRole,
      layout,
      primarySidebarPreferredVisible,
      width,
    ],
  );
  const environmentId = firstRouteParam(params.environmentId);
  const threadId = firstRouteParam(params.threadId);
  const selectedThreadKey =
    environmentId !== null && threadId !== null
      ? scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(threadId))
      : null;
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
  const showAuxiliaryPane = useCallback((role: WorkspaceAuxiliaryPaneRole) => {
    if (role === "inspector") {
      setFileInspectorPreferredVisible(true);
      return;
    }
    setSupplementaryPanePreferredVisible(true);
  }, []);
  const toggleAuxiliaryPane = useCallback(() => {
    if (auxiliaryPaneRole === "inspector") {
      setFileInspectorPreferredVisible((current) => !current);
      return;
    }
    setSupplementaryPanePreferredVisible((current) => !current);
  }, [auxiliaryPaneRole]);
  const contextValue = useMemo(
    () => ({
      layout,
      panes,
      fileInspector,
      activateAuxiliaryPaneRole,
      showAuxiliaryPane,
      toggleAuxiliaryPane,
      togglePrimarySidebar,
    }),
    [
      activateAuxiliaryPaneRole,
      fileInspector,
      layout,
      panes,
      showAuxiliaryPane,
      toggleAuxiliaryPane,
      togglePrimarySidebar,
    ],
  );

  useEffect(() => {
    sidebarProgress.value = withTiming(panes.primarySidebarVisible ? 1 : 0, { duration: 220 });
  }, [panes.primarySidebarVisible, sidebarProgress]);
  const sidebarStyle = useAnimatedStyle(() => ({
    opacity: sidebarProgress.value,
    transform: [{ translateX: (sidebarProgress.value - 1) * 24 }],
  }));

  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      const destination = buildThreadRoutePath(thread);
      const navigationAction = resolveThreadSelectionNavigationAction({
        usesSplitView: layout.usesSplitView,
        pathname,
      });
      if (navigationAction === "set-params") {
        // Auxiliary content belongs to the current thread. Close it before
        // reusing the current native detail screen for a peer thread selection.
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
    [layout.usesSplitView, pathname, router],
  );

  return (
    <AdaptiveWorkspaceContext.Provider value={contextValue}>
      <View testID="adaptive-workspace-layout" style={{ flex: 1, flexDirection: "row" }}>
        {layout.usesSplitView && layout.listPaneWidth !== null ? (
          <Animated.View
            accessibilityElementsHidden={!panes.primarySidebarVisible}
            collapsable={false}
            importantForAccessibility={panes.primarySidebarVisible ? "auto" : "no-hide-descendants"}
            layout={WORKSPACE_PANE_LAYOUT_TRANSITION}
            pointerEvents={panes.primarySidebarVisible ? "auto" : "none"}
            style={[
              {
                alignSelf: "stretch",
                overflow: "hidden",
                width: panes.primarySidebarVisible ? layout.listPaneWidth : 0,
              },
              sidebarStyle,
            ]}
          >
            <ThreadNavigationSidebar
              width={layout.listPaneWidth}
              selectedThreadKey={selectedThreadKey}
              onOpenSettings={() => router.push("/settings")}
              onSelectThread={handleSelectThread}
              onStartNewTask={() => router.push("/new")}
            />
          </Animated.View>
        ) : null}
        <Animated.View
          collapsable={false}
          layout={WORKSPACE_PANE_LAYOUT_TRANSITION}
          style={{ flex: 1 }}
        >
          {props.children}
        </Animated.View>
      </View>
    </AdaptiveWorkspaceContext.Provider>
  );
}
