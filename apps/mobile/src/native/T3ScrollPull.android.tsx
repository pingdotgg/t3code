import { requireNativeView } from "expo";
import type { PropsWithChildren } from "react";
import Animated from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import type { T3ScrollPullProps, T3ScrollPullScrimProps } from "./T3ScrollPull";

export type { ScrollPullEvent } from "./T3ScrollPull";

/** The native view reports the pull, so the feed's own events only mark where a drag starts. */
export const SCROLL_PULL_FEED_EVENTS = ["onScrollBeginDrag"];

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

/** The stretch opens no space past the end, so a fade keeps the pull badge readable over the feed. */
export function T3ScrollPullScrim(props: T3ScrollPullScrimProps) {
  return (
    <Animated.View
      pointerEvents="none"
      className="absolute inset-x-0 bottom-0"
      style={[{ height: props.height }, props.style]}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="thread-pull-scrim" x1="0%" x2="0%" y1="0%" y2="100%">
            <Stop offset="0%" stopColor={props.color} stopOpacity={0} />
            <Stop
              offset={props.fadeHeight / props.height}
              stopColor={props.color}
              stopOpacity={1}
            />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#thread-pull-scrim)" />
      </Svg>
    </Animated.View>
  );
}
