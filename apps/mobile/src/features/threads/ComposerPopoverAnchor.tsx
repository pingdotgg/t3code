import type { ReactNode } from "react";
import { View } from "react-native";

/** Places a composer popover just above the composer. */
export function ComposerPopoverAnchor(props: { readonly children: ReactNode }) {
  return <View className="absolute inset-x-0 bottom-full z-10 mb-2">{props.children}</View>;
}
