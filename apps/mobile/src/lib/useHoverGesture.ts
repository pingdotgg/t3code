import { useState } from "react";
import { Gesture, PointerType } from "react-native-gesture-handler";

export function useHoverGesture(disabled = false) {
  const [hovered, setHovered] = useState(false);
  const hoverGesture = Gesture.Hover()
    .manualActivation(true)
    .enabled(!disabled)
    .cancelsTouchesInView(false)
    .runOnJS(true)
    .onBegin((event) => {
      setHovered(
        event.pointerType === PointerType.MOUSE || event.pointerType === PointerType.STYLUS,
      );
    })
    .onFinalize(() => {
      setHovered(false);
    });
  return { hovered: !disabled && hovered, hoverGesture };
}
