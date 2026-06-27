import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { constrainAuxiliaryPaneWidth } from "../../lib/layout";
import { useAdaptiveWorkspaceLayout } from "./AdaptiveWorkspaceLayout";
import { WorkspacePaneDivider } from "./workspace-pane-divider";

export function AdaptiveInspectorLayout(props: {
  readonly children: ReactNode;
  readonly renderInspector?: () => ReactNode;
}) {
  const { panes, setAuxiliaryPaneWidth } = useAdaptiveWorkspaceLayout();
  const inspectorWidth = panes.auxiliaryPaneWidth;
  const inspectorSupported = props.renderInspector !== undefined && inspectorWidth !== null;
  const inspectorVisible = inspectorSupported && panes.auxiliaryPaneVisible;
  const resizeStartWidth = useRef(0);
  const [resizing, setResizing] = useState(false);

  // A file-to-file replace remounts the route. Initialize an already-visible
  // inspector at its final position so route replacement never replays an
  // entering transition. Only visibility and explicit resizing change it.
  const inspectorProgress = useSharedValue(inspectorVisible ? 1 : 0);
  const renderedInspectorWidth = useSharedValue(inspectorVisible ? (inspectorWidth ?? 0) : 0);

  useEffect(() => {
    inspectorProgress.value = withTiming(inspectorVisible ? 1 : 0, {
      duration: inspectorVisible ? 220 : 160,
      easing: inspectorVisible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
    const targetWidth = inspectorVisible ? (inspectorWidth ?? 0) : 0;
    renderedInspectorWidth.value = resizing
      ? targetWidth
      : withTiming(targetWidth, {
          duration: inspectorVisible ? 220 : 160,
          easing: inspectorVisible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
          reduceMotion: ReduceMotion.System,
        });
  }, [inspectorProgress, inspectorVisible, inspectorWidth, renderedInspectorWidth, resizing]);

  const inspectorStyle = useAnimatedStyle(
    () => ({
      opacity: inspectorProgress.value,
      transform: [{ translateX: (1 - inspectorProgress.value) * 24 }],
      width: renderedInspectorWidth.value,
    }),
    [],
  );
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
    <View className="flex-1 flex-row">
      <Animated.View collapsable={false} className="min-w-0 flex-1">
        {props.children}
      </Animated.View>
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
          <View style={{ flex: 1, width: inspectorWidth }}>{props.renderInspector?.()}</View>
        </Animated.View>
      ) : null}
    </View>
  );
}
