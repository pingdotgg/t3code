import { requireNativeView } from "expo";
import type { PropsWithChildren } from "react";
import Animated from "react-native-reanimated";

import type { T3ScrollPullProps } from "./T3ScrollPull";

export type { ScrollPullEvent } from "./T3ScrollPull";

/** The native view reports the pull, so the feed's own events only mark where a drag starts. */
export const SCROLL_PULL_FEED_EVENTS = ["onScrollBeginDrag"];

/** The native view reports the sideways swing as `dx`. */
export const SCROLL_PULL_SWING_FROM_FEED_TOUCHES = false;

const NativeScrollPull = Animated.createAnimatedComponent(
  requireNativeView<PropsWithChildren<T3ScrollPullProps>>("T3ScrollPull"),
);

export function T3ScrollPull(props: PropsWithChildren<T3ScrollPullProps>) {
  return (
    <NativeScrollPull style={props.style} onPull={props.onPull}>
      {props.children}
    </NativeScrollPull>
  );
}
