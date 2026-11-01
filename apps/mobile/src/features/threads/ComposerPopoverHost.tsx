import type { ReactNode, RefObject } from "react";
import { createContext, useContext, useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";
import type { SharedValue } from "react-native-reanimated";

type ComposerPopoverHostValue = {
  readonly hostRef: RefObject<ViewInstance | null>;
  readonly setContent: (content: ReactNode) => void;
  readonly layoutVersion: number;
  readonly popoverHeight: SharedValue<number>;
  /** Room between the header and the composer's top, or null when unknown. */
  readonly popoverRoom: number | null;
  readonly composerHeight: number;
};

const ComposerPopoverHostContext = createContext<ComposerPopoverHostValue | null>(null);

export function useComposerPopoverHost() {
  return useContext(ComposerPopoverHostContext);
}

export const COMPOSER_POPOVER_GAP = 8;
// The group label plus about three rows.
const COMPOSER_POPOVER_MIN_HEIGHT = 160;

/**
 * With too little room above the composer (the Duo's front screen, keyboard up), the popover pins
 * below the header and grows down over the composer, stopping at its bottom edge so no row hides
 * behind the keyboard. `above` is the height it can use above the composer.
 */
export function composerPopoverPlacement(host: ComposerPopoverHostValue | null) {
  if (host?.popoverRoom == null) return null;
  const above = Math.max(0, host.popoverRoom - COMPOSER_POPOVER_GAP * 2);
  if (above >= COMPOSER_POPOVER_MIN_HEIGHT) {
    return { above, maxHeight: above, pinnedToTop: false };
  }
  const maxHeight = Math.min(
    COMPOSER_POPOVER_MIN_HEIGHT,
    above + host.composerHeight - COMPOSER_POPOVER_GAP,
  );
  return { above, maxHeight, pinnedToTop: true };
}

/** Mount inside KeyboardStickyView for Android gestures. Hide explicitly because portal content outlives its subtree. */
export function ComposerPopoverHost(props: {
  readonly hidden: boolean;
  readonly popoverHeight: SharedValue<number>;
  readonly popoverRoom: number | null;
  readonly composerHeight: number;
  readonly children: ReactNode;
}) {
  const hostRef = useRef<ViewInstance>(null);
  const [content, setContent] = useState<ReactNode>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const value = {
    hostRef,
    setContent,
    layoutVersion,
    popoverHeight: props.popoverHeight,
    popoverRoom: props.popoverRoom,
    composerHeight: props.composerHeight,
  };

  return (
    <ComposerPopoverHostContext.Provider value={value}>
      <View
        ref={hostRef}
        collapsable={false}
        pointerEvents="box-none"
        className="absolute inset-0"
        onLayout={() => setLayoutVersion((version) => version + 1)}
      >
        {props.children}
        {props.hidden ? null : content}
      </View>
    </ComposerPopoverHostContext.Provider>
  );
}
