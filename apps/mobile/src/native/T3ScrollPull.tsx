import type { PropsWithChildren } from "react";
import { View, type GestureResponderEvent, type StyleProp, type ViewStyle } from "react-native";

/** Distances in dp, velocity in dp/ms; `released` is false when the touch was cancelled. */
export type ScrollPullEvent =
  | { readonly distance: number; readonly dx: number; readonly dy: number }
  | { readonly released: boolean; readonly velocity: number };

export interface T3ScrollPullProps {
  readonly style?: StyleProp<ViewStyle>;
  readonly onPull?: ((event: ScrollPullEvent) => void) | undefined;
  /** The finger's window position, where the native view does not report the swing itself. */
  readonly onFinger?: ((x: number, y: number) => void) | undefined;
}

/** iOS reads the pull from the feed's own bounce, so the feed's scroll and drag events carry it. */
export const SCROLL_PULL_FEED_EVENTS = ["onScroll", "onScrollBeginDrag", "onScrollEndDrag"];

/** There is no native pull view here, so the feed's touches give the swing. */
export const SCROLL_PULL_SWING_FROM_FEED_TOUCHES = true;

export function T3ScrollPull(props: PropsWithChildren<T3ScrollPullProps>) {
  const { onFinger } = props;
  const report = (event: GestureResponderEvent) =>
    onFinger?.(event.nativeEvent.pageX, event.nativeEvent.pageY);
  // Raw touches keep arriving while the feed scrolls. A gesture handler bound to the scroll view
  // would also read them, but it leaves Legend List with blank space past the last message.
  return (
    <View style={props.style} onTouchStart={report} onTouchMove={report}>
      {props.children}
    </View>
  );
}
