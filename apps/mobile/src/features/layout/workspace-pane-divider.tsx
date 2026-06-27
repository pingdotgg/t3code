import { useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Platform,
  PlatformColor,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
} from "react-native";

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
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => {
          const horizontalDistance = Math.abs(gesture.dx);
          return horizontalDistance >= 4 && horizontalDistance > Math.abs(gesture.dy) * 1.25;
        },
        onPanResponderGrant: () => {
          setDragging(true);
          latestProps.current.onResizeStart?.();
        },
        onPanResponderMove: (_event, gesture) => {
          latestProps.current.onResizeBy(gesture.dx * latestProps.current.resizeDirection);
        },
        onPanResponderRelease: () => {
          setDragging(false);
          latestProps.current.onResizeEnd?.();
        },
        onPanResponderTerminate: () => {
          setDragging(false);
          latestProps.current.onResizeEnd?.();
        },
      }),
    [],
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
    <Pressable
      {...panResponder.panHandlers}
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
      style={styles.hitTarget}
    >
      <View style={[styles.line, (hovered || dragging) && styles.activeLine]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hitTarget: {
    alignSelf: "stretch",
    cursor: "pointer",
    justifyContent: "center",
    marginHorizontal: -22,
    width: 44,
    zIndex: 20,
  },
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
