import { type ReactNode, useMemo, useRef } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { SymbolView } from "../../components/AppSymbol";

export function ArrangementRow(props: {
  height: number;
  offset: number;
  lifted: boolean;
  dragging: boolean;
  children: ReactNode;
}) {
  const { dragging, offset, lifted } = props;
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: dragging
          ? withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System })
          : offset,
      },
    ],
    opacity: lifted ? 0 : 1,
  }));
  return (
    <Reanimated.View
      style={[{ height: props.height }, style]}
      className="flex-row items-center border-b border-border-subtle px-5"
    >
      {props.children}
    </Reanimated.View>
  );
}

/** Native pan recognition wins over list scrolling only inside the handle. */
export function DragHandle(props: {
  title: string;
  disabled: boolean;
  onStart: () => void;
  onMove: (translation: number) => void;
  onEnd: (cancelled: boolean) => void;
  onStep: (direction: "up" | "down") => void;
  sectionActions: readonly { name: "pinned" | "active" | "settled"; label: string }[];
  onSectionMove: (section: "pinned" | "active" | "settled") => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const latest = useRef(props);
  latest.current = props;
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!props.disabled)
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart(() => latest.current.onStart())
        .onUpdate((event) => latest.current.onMove(event.translationY))
        .onEnd((event) => latest.current.onMove(event.translationY))
        .onFinalize((_, success) => latest.current.onEnd(!success)),
    [props.disabled],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${props.title}`}
        accessibilityHint="Move up and Move down reorder within this section. Other actions move between sections."
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={[
          ...props.sectionActions,
          ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (props.disabled) return;
          const sectionAction = props.sectionActions.find(
            (action) => action.name === nativeEvent.actionName,
          );
          if (sectionAction) props.onSectionMove(sectionAction.name);
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        style={{
          width: 48,
          height: 48,
          alignItems: "center",
          justifyContent: "center",
          opacity: props.disabled ? 0.3 : 1,
        }}
      >
        <SymbolView
          name="line.3.horizontal"
          size={22}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}
