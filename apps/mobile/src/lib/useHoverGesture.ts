import { useMemo, useState } from "react";
import { Gesture } from "react-native-gesture-handler";

/** Uses native hover recognition without React Native's optional pointer-event flags. */
export function useHoverGesture(disabled = false) {
  const [hovered, setHovered] = useState(false);
  const hoverGesture = useMemo(
    () =>
      Gesture.Hover()
        .manualActivation(true)
        .enabled(!disabled)
        // Observe hover without competing with row taps, scrolling, or swipe actions.
        .cancelsTouchesInView(false)
        .runOnJS(true)
        .onBegin(() => {
          setHovered(true);
        })
        .onFinalize(() => {
          setHovered(false);
        }),
    [disabled],
  );
  return { hovered: !disabled && hovered, hoverGesture };
}
