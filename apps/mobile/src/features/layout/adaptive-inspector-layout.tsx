import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useAdaptiveWorkspaceLayout } from "./AdaptiveWorkspaceLayout";

export function AdaptiveInspectorLayout(props: {
  readonly children: ReactNode;
  readonly renderInspector?: () => ReactNode;
}) {
  const { panes } = useAdaptiveWorkspaceLayout();
  const inspectorWidth = panes.auxiliaryPaneWidth;
  const inspectorSupported = props.renderInspector !== undefined && inspectorWidth !== null;
  const inspectorVisible = inspectorSupported && panes.auxiliaryPaneVisible;

  // A file-to-file replace remounts the route. Initialize an already-visible
  // inspector at its final position so route replacement never replays an
  // entering transition. Only an explicit visibility change animates it.
  const inspectorProgress = useSharedValue(inspectorVisible ? 1 : 0);

  useEffect(() => {
    inspectorProgress.value = withTiming(inspectorVisible ? 1 : 0, {
      duration: inspectorVisible ? 220 : 160,
      easing: inspectorVisible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    });
  }, [inspectorProgress, inspectorVisible]);

  const inspectorStyle = useAnimatedStyle(
    () => ({
      opacity: inspectorProgress.value,
      transform: [{ translateX: (1 - inspectorProgress.value) * 24 }],
    }),
    [],
  );

  return (
    <View className="flex-1 flex-row">
      <Animated.View collapsable={false} className="min-w-0 flex-1">
        {props.children}
      </Animated.View>
      {inspectorSupported ? (
        <Animated.View
          accessibilityElementsHidden={!inspectorVisible}
          collapsable={false}
          importantForAccessibility={inspectorVisible ? "auto" : "no-hide-descendants"}
          pointerEvents={inspectorVisible ? "auto" : "none"}
          style={[
            {
              flexShrink: 0,
              overflow: "hidden",
              width: inspectorVisible ? inspectorWidth : 0,
            },
            inspectorStyle,
          ]}
        >
          <View style={{ flex: 1, width: inspectorWidth }}>{props.renderInspector?.()}</View>
        </Animated.View>
      ) : null}
    </View>
  );
}
