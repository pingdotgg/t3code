import type { PropsWithChildren } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

/** Distances in dp, velocity in dp/ms; `released` is false when the touch was cancelled. */
export type ScrollPullEvent =
  | { readonly distance: number; readonly dx: number }
  | { readonly released: boolean; readonly velocity: number };

export interface T3ScrollPullProps {
  readonly style?: StyleProp<ViewStyle>;
  readonly onPull?: ((event: ScrollPullEvent) => void) | undefined;
}

/** iOS reads the pull from the feed's own bounce, so the feed's scroll and drag events carry it. */
export const SCROLL_PULL_FEED_EVENTS = ["onScroll", "onScrollBeginDrag", "onScrollEndDrag"];

/** There is no native pull view here, so a gesture on the feed's scroll view reads the swing. */
export const SCROLL_PULL_SWING_FROM_FEED_TOUCHES = true;

export function T3ScrollPull(props: PropsWithChildren<T3ScrollPullProps>) {
  return <View style={props.style}>{props.children}</View>;
}
