import { requireNativeView } from "expo";
import type { PropsWithChildren } from "react";
import Animated from "react-native-reanimated";

import type { T3ScrollPullProps } from "./T3ScrollPull";

export type { ScrollPullEvent } from "./T3ScrollPull";

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
