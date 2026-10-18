import { useEffectEvent, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { SymbolView } from "../../../components/ui/AppSymbol";

export function SettingsDragHandle(props: {
  readonly title: string;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onStart: () => void;
  readonly onMove: (translation: number) => void;
  readonly onEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
}) {
  // Gesture callbacks fire outside render, so effect events give them the
  // latest props while the gesture object itself stays stable.
  const onStart = useEffectEvent(() => props.onStart());
  const onMove = useEffectEvent((translation: number) => props.onMove(translation));
  const onEnd = useEffectEvent((translation: number, cancelled: boolean) =>
    props.onEnd(translation, cancelled),
  );
  const [gesture] = useState(() => {
    let translation = 0;
    return Gesture.Pan()
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onStart(() => {
        translation = 0;
        onStart();
      })
      .onUpdate((event) => {
        translation = event.translationY;
        onMove(event.translationY);
      })
      .onFinalize((_, success) => onEnd(translation, !success));
  });
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${props.title}`}
        accessibilityActions={[
          ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        style={{ width: 48, alignSelf: "stretch", alignItems: "center", justifyContent: "center" }}
      >
        <SymbolView
          name="line.3.horizontal"
          size={20}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}
