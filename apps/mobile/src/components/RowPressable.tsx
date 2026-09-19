import type { ComponentProps, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { cn } from "../lib/cn";
import { useHoverGesture } from "../lib/useHoverGesture";

/** Pointer feedback layered over selection. Touch-down may be the start of a scroll. */
export function RowPressable({
  children,
  className,
  interactionClassName = "bg-row-hover",
  interactionOpacity = 1,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly children: ReactNode;
  readonly interactionClassName?: string;
  readonly interactionOpacity?: number;
}) {
  const { hovered, hoverGesture } = useHoverGesture(props.disabled ?? false);
  return (
    <GestureDetector gesture={hoverGesture}>
      <Pressable {...props} className={cn("relative overflow-hidden", className)}>
        {() => (
          <>
            <View
              pointerEvents="none"
              className={cn("absolute inset-0", interactionClassName)}
              style={{ opacity: props.disabled || !hovered ? 0 : interactionOpacity }}
            />
            {children}
          </>
        )}
      </Pressable>
    </GestureDetector>
  );
}
