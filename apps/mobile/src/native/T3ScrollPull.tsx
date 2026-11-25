import type { PropsWithChildren } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { AnimatedStyle } from "react-native-reanimated";

/** `distance` is in dp and `velocity` in dp/ms; `released` is false when the touch was cancelled. */
export type ScrollPullEvent =
  | { readonly distance: number }
  | { readonly released: boolean; readonly velocity: number };

export interface T3ScrollPullProps {
  readonly style?: StyleProp<ViewStyle>;
  readonly onPull?: ((event: ScrollPullEvent) => void) | undefined;
}

export interface T3ScrollPullScrimProps {
  readonly height: number;
  readonly fadeHeight: number;
  readonly color: string;
  readonly style: StyleProp<AnimatedStyle<ViewStyle>>;
}

/** iOS reads the pull from the feed's own bounce, so the feed's scroll and drag events carry it. */
export const SCROLL_PULL_FEED_EVENTS = ["onScroll", "onScrollBeginDrag", "onScrollEndDrag"];

export function T3ScrollPull(props: PropsWithChildren<T3ScrollPullProps>) {
  return <View style={props.style}>{props.children}</View>;
}

/** The bounce opens empty space past the end, so the pull badge needs no backdrop. */
export function T3ScrollPullScrim(_props: T3ScrollPullScrimProps) {
  return null;
}
