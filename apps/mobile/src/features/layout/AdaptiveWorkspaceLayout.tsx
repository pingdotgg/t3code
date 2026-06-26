import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useFocusEffect, useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";

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

  const handleOpenSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);
  const handleStartNewTask = useCallback(() => {
    router.push("/new");
  }, [router]);

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
    <AdaptiveWorkspaceContext.Provider value={contextValue}>
      <View testID="adaptive-workspace-layout" style={{ flex: 1, flexDirection: "row" }}>
        {layout.usesSplitView && layout.listPaneWidth !== null ? (
          <View
            accessibilityElementsHidden={!panes.primarySidebarVisible}
            collapsable={false}
            importantForAccessibility={panes.primarySidebarVisible ? "auto" : "no-hide-descendants"}
            pointerEvents={panes.primarySidebarVisible ? "auto" : "none"}
            style={{
              alignSelf: "stretch",
              overflow: "hidden",
              width: panes.primarySidebarVisible ? layout.listPaneWidth : 0,
            }}
          >
            <ThreadNavigationSidebar
              width={layout.listPaneWidth}
              selectedThreadKey={selectedThreadKey}
              onOpenSettings={handleOpenSettings}
              onSelectThread={handleSelectThread}
              onStartNewTask={handleStartNewTask}
            />
          </View>
        ) : null}
        <View collapsable={false} style={{ flex: 1 }}>
          {props.children}
        </View>
      </View>
    </AdaptiveWorkspaceContext.Provider>
  );
}
