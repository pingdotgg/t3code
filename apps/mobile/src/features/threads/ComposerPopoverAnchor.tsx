import type { ReactNode } from "react";
import { useEffect } from "react";
import { View } from "react-native";

import {
  COMPOSER_POPOVER_GAP,
  composerPopoverPlacement,
  useComposerPopoverHost,
} from "./ComposerPopoverHost";

export function ComposerPopoverAnchor(props: {
  readonly children: (overlapsComposer: boolean) => ReactNode;
}) {
  const host = useComposerPopoverHost();
  const popoverHeight = host?.popoverHeight;
  const placement = composerPopoverPlacement(host);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the popover host's shared height value when the anchor unmounts
  useEffect(
    () => () => {
      popoverHeight?.set(0);
    },
    [popoverHeight],
  );
  return (
    <View
      className="absolute inset-x-0 z-10"
      style={
        placement?.pinnedToTop
          ? { top: -(COMPOSER_POPOVER_GAP + placement.above), maxHeight: placement.maxHeight }
          : { bottom: "100%", marginBottom: COMPOSER_POPOVER_GAP, maxHeight: placement?.maxHeight }
      }
      onLayout={(event) => {
        popoverHeight?.set(
          placement?.pinnedToTop ? placement.above : event.nativeEvent.layout.height,
        );
      }}
    >
      {props.children(placement?.pinnedToTop === true)}
    </View>
  );
}
