import type { ReactNode, RefObject } from "react";
import { createContext, useContext, useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";
import type { SharedValue } from "react-native-reanimated";

type ComposerPopoverHostValue = {
  readonly hostRef: RefObject<ViewInstance | null>;
  readonly setContent: (content: ReactNode) => void;
  readonly layoutVersion: number;
  readonly popoverHeight: SharedValue<number>;
};

const ComposerPopoverHostContext = createContext<ComposerPopoverHostValue | null>(null);

export function useComposerPopoverHost() {
  return useContext(ComposerPopoverHostContext);
}

/** Mount inside KeyboardStickyView for Android gestures. Hide explicitly because portal content outlives its subtree. */
export function ComposerPopoverHost(props: {
  readonly hidden: boolean;
  readonly popoverHeight: SharedValue<number>;
  readonly children: ReactNode;
}) {
  const hostRef = useRef<ViewInstance>(null);
  const [content, setContent] = useState<ReactNode>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const value = { hostRef, setContent, layoutVersion, popoverHeight: props.popoverHeight };

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
