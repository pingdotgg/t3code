import type { PropsWithChildren } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

/** `distance` is in dp and `velocity` in dp/ms; `released` is false when the touch was cancelled. */
export type ScrollPullEvent =
  | { readonly distance: number }
  | { readonly released: boolean; readonly velocity: number };

export interface T3ScrollPullProps {
  readonly style?: StyleProp<ViewStyle>;
  readonly onPull?: ((event: ScrollPullEvent) => void) | undefined;
}

export function T3ScrollPull(props: PropsWithChildren<T3ScrollPullProps>) {
  return <View style={props.style}>{props.children}</View>;
}
