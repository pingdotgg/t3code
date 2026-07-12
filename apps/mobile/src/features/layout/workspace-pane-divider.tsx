import { useCallback, useMemo, useRef, useState } from "react";
import {
  Platform,
  PlatformColor,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

const ACCESSIBILITY_RESIZE_STEP = 24;

interface WorkspacePaneDividerProps {
  readonly accessibilityLabel: string;
  readonly currentWidth: number;
  /** 1 when dragging right grows the pane, -1 when dragging left grows it. */
  readonly resizeDirection: 1 | -1;
  readonly onResizeStart?: () => void;
  readonly onResizeBy: (delta: number) => void;
  readonly onResizeEnd?: () => void;
}

/** A forgiving divider target for touch, pointer, and VoiceOver users. */
export function WorkspacePaneDivider(props: WorkspacePaneDividerProps) {
  const latestProps = useRef(props);
  latestProps.current = props;
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const handleResizeStart = useCallback(() => {
    setDragging(true);
    latestProps.current.onResizeStart?.();
  }, []);
  const handleResize = useCallback((translationX: number) => {
    latestProps.current.onResizeBy(translationX * latestProps.current.resizeDirection);
  }, []);
  const handleResizeEnd = useCallback(() => {
    setDragging(false);
    latestProps.current.onResizeEnd?.();
  }, []);
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-4, 4])
        .failOffsetY([-24, 24])
        .onStart(() => {
          runOnJS(handleResizeStart)();
        })
        .onUpdate((event) => {
          runOnJS(handleResize)(event.translationX);
        })
        .onFinalize(() => {
          runOnJS(handleResizeEnd)();
        }),
    [handleResize, handleResizeEnd, handleResizeStart],
  );

  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    props.onResizeStart?.();
    if (event.nativeEvent.actionName === "increment") {
      props.onResizeBy(ACCESSIBILITY_RESIZE_STEP);
    } else if (event.nativeEvent.actionName === "decrement") {
      props.onResizeBy(-ACCESSIBILITY_RESIZE_STEP);
    }
    props.onResizeEnd?.();
  };

  return (
    <GestureDetector gesture={resizeGesture}>
      <Pressable
        className="relative z-[100] -mx-[22px] w-11 self-stretch cursor-pointer justify-center"
        accessibilityActions={[
          { name: "increment", label: "Make pane wider" },
          { name: "decrement", label: "Make pane narrower" },
        ]}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="adjustable"
        accessibilityValue={{
          now: Math.round(props.currentWidth),
          text: `${Math.round(props.currentWidth)} points wide`,
        }}
        onAccessibilityAction={handleAccessibilityAction}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
      >
        <View style={[styles.line, (hovered || dragging) && styles.activeLine]} />
      </Pressable>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  line: {
    alignSelf: "center",
    backgroundColor:
      Platform.OS === "ios" ? PlatformColor("separator") : "rgba(120, 120, 128, 0.28)",
    height: "100%",
    opacity: 0.7,
    width: StyleSheet.hairlineWidth,
  },
  activeLine: {
    backgroundColor: Platform.OS === "ios" ? PlatformColor("systemBlueColor") : "#0a84ff",
    opacity: 1,
    width: 2,
  },
});
