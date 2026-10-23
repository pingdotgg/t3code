import { useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewProps } from "react-native";

/**
 * A scroll view with a manual top inset rests at `-topInset`, just below the header. The inset
 * can change after mount: a column's safe area starts as the window's until UIKit measures it,
 * and rotation or folding changes it again. While the view rests below the header it follows the
 * inset; once scrolled away it holds the last resting offset, because RN re-applies a changed
 * `contentOffset` prop and would move the reader.
 */
export function holdRestingTopOffset(held: number | null, scrollY: number, topInset: number) {
  return Math.abs(scrollY + topInset) <= 1 ? null : (held ?? -topInset);
}

export function useRestingTopOffset(
  topInset: number,
  props: Pick<ScrollViewProps, "contentOffset" | "onScroll">,
) {
  // A list restoring a saved position mounts away from its resting offset.
  const [held, setHeld] = useState(props.contentOffset?.y ?? null);
  return {
    contentOffset: { x: 0, y: held ?? -topInset },
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const scrollY = event.nativeEvent.contentOffset.y;
      setHeld((current) => holdRestingTopOffset(current, scrollY, topInset));
      props.onScroll?.(event);
    },
  };
}
