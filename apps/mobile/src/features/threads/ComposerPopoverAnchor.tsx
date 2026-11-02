import type { ReactNode } from "react";
import { useEffect } from "react";
import { View } from "react-native";

import { useComposerPopoverHost } from "./ComposerPopoverHost";

export function ComposerPopoverAnchor(props: { readonly children: ReactNode }) {
  const popoverHeight = useComposerPopoverHost()?.popoverHeight;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the popover host's shared height value when the anchor unmounts
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
