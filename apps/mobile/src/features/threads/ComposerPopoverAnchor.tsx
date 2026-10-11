import type { ReactNode } from "react";
import { useEffect } from "react";
import { View } from "react-native";

import { useComposerPopoverHost } from "./ComposerPopoverHost";

/** Places a composer popover just above the composer. */
export function ComposerPopoverAnchor(props: { readonly children: ReactNode }) {
  const popoverHeight = useComposerPopoverHost()?.popoverHeight;
  useEffect(
    () => () => {
      popoverHeight?.set(0);
    },
    [popoverHeight],
  );
  return (
    <View
      className="absolute inset-x-0 bottom-full z-10 mb-2"
      onLayout={(event) => {
        popoverHeight?.set(event.nativeEvent.layout.height);
      }}
    >
      {props.children}
    </View>
  );
}
