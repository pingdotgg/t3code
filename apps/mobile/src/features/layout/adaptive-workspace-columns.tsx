import Animated from "react-native-reanimated";
import type { AnimatedStyle, SharedValue } from "react-native-reanimated";
import { Platform, View, type ViewStyle } from "react-native";
import { SafeAreaInsetsContext, type EdgeInsets } from "react-native-safe-area-context";
import type { ReactNode } from "react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { VerticalHinge, deriveLayout, deriveWorkspacePaneLayout } from "../../lib/layout";
import type { PendingNewTask } from "../../state/pending-new-tasks-model";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import { AndroidHingeObserver } from "../../native/AndroidHingeObserver";
import { FLOATING_TABS } from "../workspace/floating-workspace-tabs";
import {
  AndroidWorkspaceNavigation,
  FloatingWorkspaceTabs,
} from "../workspace/AndroidWorkspaceNavigation";
import { AndroidWorkspaceSidebar } from "../workspace/AndroidWorkspaceSidebar";
import { AndroidHomeFabLayout } from "../home/AndroidHomeFab";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { SettingsWorkspaceLayout } from "../settings/SettingsWorkspaceLayout";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";
import {
  WorkspaceContentWidthContext,
  WorkspaceSettledContentWidthContext,
} from "./workspace-content-width";
import { WorkspaceInspectorPane } from "./workspace-inspector-pane";

export interface AdaptiveWorkspaceColumnsProps {
  readonly children: ReactNode;
  readonly selectedPullRequestKey: string | null;
  readonly layout: ReturnType<typeof deriveLayout>;
  readonly panes: ReturnType<typeof deriveWorkspacePaneLayout>;
  readonly compactAndroidSettings: boolean;
  readonly contentTargetWidth: number | null;
  readonly floatingTabs: { readonly height: number };
  readonly floatingTabsEnabled: boolean;
  readonly handleHingeChange: (
    next: VerticalHinge | null,
    nextWindow: VerticalHinge | null,
  ) => void;
  readonly handleNewThreadInProject: (project: EnvironmentProject) => void;
  readonly handleNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly handleOpenEnvironmentSettings: () => void;
  readonly handleOpenPendingTask: (pendingTask: PendingNewTask) => void;
  readonly handleOpenSettings: () => void;
  readonly handleOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly handleSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly handleStartNewTask: () => void;
  readonly handleWorkspaceInspectorClosed: () => void;
  readonly listPaneAnimatedStyle: AnimatedStyle<ViewStyle>;
  readonly navigationRailWidth: number;
  readonly railAnimatedStyle: AnimatedStyle<ViewStyle>;
  readonly renderedContentWidth: SharedValue<number>;
  readonly renderedInspectorWidth: SharedValue<number>;
  readonly revealPrimarySidebar: () => void;
  readonly safeAreaInsets: EdgeInsets;
  readonly selectedThreadKey: string | null;
  readonly setAuxiliaryPaneWidth: (nextWidth: number) => void;
  readonly shouldRenderNavigationRail: boolean;
  readonly shouldRenderPrimarySidebar: boolean;
  readonly sidebarAnimatedStyle: AnimatedStyle<ViewStyle>;
  readonly viewportWidth: number;
  readonly workspacePage: boolean;
  readonly workspaceInspector: {
    readonly active: boolean;
    readonly render?: () => ReactNode;
  } | null;
  readonly primarySidebarSearchQuery: string;
  readonly setPrimarySidebarSearchQuery: (query: string) => void;
  readonly androidContentSlotStyle: AnimatedStyle<ViewStyle>;
  readonly androidNavigatorLimit: AnimatedStyle<ViewStyle>;
  readonly contentAnchor: {
    readonly viewportWidth: number;
    readonly left: number;
    readonly inspector: number;
    readonly end: boolean;
  };
  readonly contentEndGap: number;
  readonly pathname: string;
  readonly railOverlay: boolean;
  readonly setRailOverlay: (overlay: boolean) => void;
}

export function AdaptiveWorkspaceColumns(props: AdaptiveWorkspaceColumnsProps) {
  const {
    layout,
    panes,
    compactAndroidSettings,
    contentTargetWidth,
    floatingTabs,
    floatingTabsEnabled,
    handleHingeChange,
    handleNewThreadInProject,
    handleNewThreadOnBranch,
    handleOpenEnvironmentSettings,
    handleOpenPendingTask,
    handleOpenSettings,
    handleOpenThreadPullRequests,
    handleSelectThread,
    handleStartNewTask,
    handleWorkspaceInspectorClosed,
    listPaneAnimatedStyle,
    navigationRailWidth,
    railAnimatedStyle,
    renderedContentWidth,
    renderedInspectorWidth,
    revealPrimarySidebar,
    safeAreaInsets,
    selectedThreadKey,
    setAuxiliaryPaneWidth,
    shouldRenderNavigationRail,
    shouldRenderPrimarySidebar,
    sidebarAnimatedStyle,
    viewportWidth,
    workspacePage,
    workspaceInspector,
    primarySidebarSearchQuery,
    setPrimarySidebarSearchQuery,
    androidContentSlotStyle,
    androidNavigatorLimit,
    contentAnchor,
    contentEndGap,
    pathname,
    railOverlay,
    setRailOverlay,
  } = props;
  return (
    <View
      testID="adaptive-workspace-layout"
      className={Platform.OS === "android" ? "flex-1 flex-row bg-header" : "flex-1 flex-row"}
    >
      <AndroidHingeObserver onChange={handleHingeChange} />
      {shouldRenderNavigationRail ? (
        <Animated.View className="shrink self-stretch" style={railAnimatedStyle} />
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
                <AndroidHomeFabLayout
                  sidebar
                  disabled={workspacePage}
                  onStartNewTask={handleStartNewTask}
                >
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
      >
        <Animated.View
          collapsable={false}
          style={[
            contentTargetWidth !== null
              ? {
                  flex: 1,
                  width: contentTargetWidth,
                  alignSelf: contentAnchor.end ? "flex-end" : "flex-start",
                  marginRight: contentAnchor.end ? contentEndGap : 0,
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
                  <SettingsWorkspaceLayout>{props.children}</SettingsWorkspaceLayout>
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
      </Animated.View>
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
        // Its trailing inset clips the old rail as soon as Android fits the workspace to a cover display.
        <View
          className="absolute inset-y-0 left-0 overflow-hidden"
          style={
            railOverlay
              ? { right: 0 }
              : { right: viewportWidth - navigationRailWidth, maxWidth: navigationRailWidth }
          }
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
}
