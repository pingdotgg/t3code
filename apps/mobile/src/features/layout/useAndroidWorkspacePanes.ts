import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { deriveLayout, deriveWorkspacePaneLayout } from "../../lib/layout";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";

/**
 * The Android pane geometry: the list pane's hinge-resize span, the content slot's
 * settled anchor and the animated widths every column reads. Kept out of the layout
 * component so its render-phase settling stays in one place.
 */
export function useAndroidWorkspacePanes(input: {
  readonly viewportWidth: number;
  readonly workspacePage: boolean;
  readonly panes: ReturnType<typeof deriveWorkspacePaneLayout>;
  readonly layout: ReturnType<typeof deriveLayout>;
  readonly navigationRailWidth: number;
  readonly shouldRenderPrimarySidebar: boolean;
  readonly nativeWorkspace: boolean;
  readonly floatingTabsEnabled: boolean;
  readonly workspaceInspector: { readonly active: boolean } | null;
}) {
  const {
    viewportWidth,
    workspacePage,
    panes,
    layout,
    navigationRailWidth,
    shouldRenderPrimarySidebar,
    nativeWorkspace,
    floatingTabsEnabled,
    workspaceInspector,
  } = input;

  const inspectorColumnTargetWidth =
    workspaceInspector !== null && workspaceInspector.active && panes.auxiliaryPaneVisible
      ? (panes.auxiliaryPaneWidth ?? 0)
      : 0;
  // Android's split content is a rounded card: keep it off the screen edge like the list card.
  const contentEndGap = Platform.OS === "android" && layout.usesSplitView ? 4 : 0;
  const contentTargetWidth = layout.usesSplitView
    ? Math.max(0, panes.contentPaneWidth - inspectorColumnTargetWidth - contentEndGap)
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- animates the Reanimated rail and sidebar width shared values toward the layout's targets
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
    opacity:
      Platform.OS === "ios" || floatingTabsEnabled
        ? 1
        : Math.min(1, renderedSidebarWidth.value / 80),
    width: renderedSidebarWidth.value,
  }));

  // Clip the navigator at its settled width so native headers and markdown reflow only once per pane toggle.
  const renderedInspectorWidth = useSharedValue(inspectorColumnTargetWidth);
  const renderedContentWidth = useDerivedValue(() =>
    Math.max(
      0,
      viewportWidth -
        renderedRailWidth.value -
        (workspacePage ? 0 : renderedSidebarWidth.value) -
        renderedInspectorWidth.value,
    ),
  );
  // Android can resize the native row before React removes its split panes on a fold.
  const androidSplit = Platform.OS === "android" && layout.usesSplitView;
  const androidContentSlotStyle = useAnimatedStyle(() => ({
    width: androidSplit ? renderedContentWidth.value : ("100%" as const),
  }));
  // While the sidebar animates, clip the settled navigator instead of reflowing its text every frame.
  const androidNavigatorLimit = useAnimatedStyle(() => ({
    maxWidth:
      androidSplit && contentTargetWidth !== null && renderedContentWidth.value < contentTargetWidth
        ? contentTargetWidth
        : ("100%" as const),
  }));
  return {
    inspectorColumnTargetWidth,
    contentEndGap,
    contentTargetWidth,
    contentAnchor,
    railAnimatedStyle,
    listPaneAnimatedStyle,
    sidebarAnimatedStyle,
    renderedInspectorWidth,
    renderedContentWidth,
    androidContentSlotStyle,
    androidNavigatorLimit,
  };
}
