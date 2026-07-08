import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { constrainAuxiliaryPaneWidth, type WorkspacePaneLayout } from "../../lib/layout";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspacePaneDivider } from "./workspace-pane-divider";

/**
 * The trailing inspector column: resize divider + animated reveal.
 *
 * Rendered by AdaptiveWorkspaceLayout as a SIBLING of the navigator so the
 * native stack header (and its trailing toolbar items) spans only the content
 * pane — the inspector owns its own full-height column, mirroring how each
 * column of a UISplitViewController has its own chrome.
 *
 * Receives the pane layout via props (not the workspace context hook) so this
 * module stays import-cycle-free with AdaptiveWorkspaceLayout.
 */
export function WorkspaceInspectorPane(props: {
  /**
   * When false the pane animates closed but keeps its content mounted for the
   * exit transition (a route that lost focus). `onClosed` fires once the
   * close animation settles so the owner can drop the stale content.
   */
  readonly active?: boolean;
  readonly onClosed?: () => void;
  readonly panes: WorkspacePaneLayout;
  readonly renderInspector?: () => ReactNode;
  readonly setAuxiliaryPaneWidth: (width: number) => void;
}) {
  const { panes, setAuxiliaryPaneWidth } = props;
  const inspectorWidth = panes.auxiliaryPaneWidth;
  const inspectorSupported = props.renderInspector !== undefined && inspectorWidth !== null;
  const inspectorVisible =
    inspectorSupported && panes.auxiliaryPaneVisible && (props.active ?? true);
  const resizeStartWidth = useRef(0);
  const [resizing, setResizing] = useState(false);

  // A file-to-file replace remounts the route. Initialize an already-visible
  // inspector at its final position so route replacement never replays an
  // entering transition. Only visibility and explicit resizing change it.
  const inspectorProgress = useSharedValue(inspectorVisible ? 1 : 0);
  const renderedInspectorWidth = useSharedValue(inspectorVisible ? (inspectorWidth ?? 0) : 0);
  // The content keeps its own width so the reveal (outer width) clips a
  // fully-laid-out pane instead of reflowing text every frame. When the OPEN
  // pane's target width changes (e.g. the sidebar toggles and reserves
  // space), animate the content width in lockstep rather than snapping.
  const renderedContentWidth = useSharedValue(inspectorWidth ?? 0);

  const onClosed = props.onClosed;
  useEffect(() => {
    inspectorProgress.value = withTiming(
      inspectorVisible ? 1 : 0,
      WORKSPACE_PANE_TIMING,
      (finished) => {
        if (finished === true && !inspectorVisible && onClosed !== undefined) {
          runOnJS(onClosed)();
        }
      },
    );
    const targetWidth = inspectorVisible ? (inspectorWidth ?? 0) : 0;
    renderedInspectorWidth.value = resizing
      ? targetWidth
      : withTiming(targetWidth, WORKSPACE_PANE_TIMING);
  }, [
    inspectorProgress,
    inspectorVisible,
    inspectorWidth,
    onClosed,
    renderedInspectorWidth,
    resizing,
  ]);

  useEffect(() => {
    const targetWidth = inspectorWidth ?? 0;
    if (!inspectorVisible || resizing) {
      // Hidden panes re-measure silently; during a divider drag the content
      // tracks the finger directly.
      renderedContentWidth.value = targetWidth;
      return;
    }
    renderedContentWidth.value = withTiming(targetWidth, WORKSPACE_PANE_TIMING);
  }, [inspectorVisible, inspectorWidth, renderedContentWidth, resizing]);

  const inspectorStyle = useAnimatedStyle(
    () => ({
      opacity: inspectorProgress.value,
      transform: [{ translateX: (1 - inspectorProgress.value) * 24 }],
      width: renderedInspectorWidth.value,
    }),
    [],
  );
  const inspectorContentStyle = useAnimatedStyle(() => ({ width: renderedContentWidth.value }), []);
  const beginResize = useCallback(() => {
    resizeStartWidth.current = inspectorWidth ?? 0;
    setResizing(true);
  }, [inspectorWidth]);
  const resizeBy = useCallback(
    (delta: number) => {
      setAuxiliaryPaneWidth(
        constrainAuxiliaryPaneWidth({
          preferredWidth: resizeStartWidth.current + delta,
          availableWidth: panes.contentPaneWidth,
        }),
      );
    },
    [panes.contentPaneWidth, setAuxiliaryPaneWidth],
  );
  const endResize = useCallback(() => {
    setResizing(false);
  }, []);

  return (
    <>
      {inspectorVisible ? (
        <WorkspacePaneDivider
          accessibilityLabel="Resize detail pane"
          currentWidth={inspectorWidth ?? 0}
          resizeDirection={-1}
          onResizeStart={beginResize}
          onResizeBy={resizeBy}
          onResizeEnd={endResize}
        />
      ) : null}
      {inspectorSupported ? (
        <Animated.View
          accessibilityElementsHidden={!inspectorVisible}
          collapsable={false}
          importantForAccessibility={inspectorVisible ? "auto" : "no-hide-descendants"}
          pointerEvents={inspectorVisible ? "auto" : "none"}
          style={[{ flexShrink: 0, overflow: "hidden" }, inspectorStyle]}
        >
          <Animated.View style={[{ flex: 1 }, inspectorContentStyle]}>
            {props.renderInspector?.()}
          </Animated.View>
        </Animated.View>
      ) : null}
    </>
  );
}
