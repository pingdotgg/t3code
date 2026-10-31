import { useEffect, useRef, useState, type ReactNode } from "react";
import Animated, {
  cubicBezier,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { constrainAuxiliaryPaneWidth, type WorkspacePaneLayout } from "../../lib/layout";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspacePaneDivider } from "./workspace-pane-divider";

// CSS form of WORKSPACE_PANE_TIMING's Easing.inOut(Easing.cubic).
const PANE_EASING = cubicBezier(0.65, 0, 0.35, 1);

/** Pass layout props to avoid an import cycle with AdaptiveWorkspaceLayout. */
export function WorkspaceInspectorPane(props: {
  readonly pathname: string;
  readonly renderedInspectorWidth: SharedValue<number>;
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

  const inspectorProgress = useSharedValue(inspectorVisible ? 1 : 0);
  const { renderedInspectorWidth } = props;
  const reduceMotion = useReducedMotion();

  const onClosed = props.onClosed;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- animates the Reanimated inspector progress and width shared values when visibility or width changes
  useEffect(() => {
    inspectorProgress.set(
      withTiming(inspectorVisible ? 1 : 0, WORKSPACE_PANE_TIMING, (finished) => {
        if (finished === true && !inspectorVisible && onClosed !== undefined) {
          runOnJS(onClosed)();
        }
      }),
    );
    const targetWidth = inspectorVisible ? (inspectorWidth ?? 0) : 0;
    renderedInspectorWidth.set(
      resizing ? targetWidth : withTiming(targetWidth, WORKSPACE_PANE_TIMING),
    );
  }, [
    inspectorProgress,
    inspectorVisible,
    inspectorWidth,
    onClosed,
    renderedInspectorWidth,
    resizing,
  ]);

  const inspectorStyle = useAnimatedStyle(
    () => ({
      opacity: inspectorProgress.value,
      transform: [{ translateX: (1 - inspectorProgress.value) * 24 }],
      width: renderedInspectorWidth.value,
    }),
    [],
  );
  // A hidden or resizing pane takes its width at once; a visible one eases with the column.
  const inspectorContentStyle = {
    width: inspectorWidth ?? 0,
    transitionProperty: "width",
    transitionDuration:
      !inspectorVisible || resizing || reduceMotion ? 0 : WORKSPACE_PANE_TIMING.duration,
    transitionTimingFunction: PANE_EASING,
  } as const;
  const beginResize = () => {
    resizeStartWidth.current = inspectorWidth ?? 0;
    setResizing(true);
  };
  const resizeBy = (delta: number) => {
    setAuxiliaryPaneWidth(
      constrainAuxiliaryPaneWidth({
        preferredWidth: resizeStartWidth.current + delta,
        availableWidth: panes.contentPaneWidth,
      }),
    );
  };
  const endResize = () => {
    setResizing(false);
  };

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
          className="shrink-0 overflow-hidden"
          accessibilityElementsHidden={!inspectorVisible}
          collapsable={false}
          importantForAccessibility={inspectorVisible ? "auto" : "no-hide-descendants"}
          pointerEvents={inspectorVisible ? "auto" : "none"}
          style={inspectorStyle}
        >
          <Animated.View className="flex-1" style={inspectorContentStyle}>
            <RenderErrorBoundary
              resetKeys={[props.pathname]}
              renderFallback={(fallback) => (
                <RenderFailureView {...fallback} title="The inspector couldn't be displayed" />
              )}
            >
              <InspectorRenderer render={props.renderInspector} />
            </RenderErrorBoundary>
          </Animated.View>
        </Animated.View>
      ) : null}
    </>
  );
}

function InspectorRenderer(props: { readonly render?: () => ReactNode }) {
  return <>{props.render?.()}</>;
}
