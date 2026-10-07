import type { ReactNode, RefObject } from "react";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";

type ComposerPopoverHostValue = {
  readonly hostRef: RefObject<ViewInstance | null>;
  readonly setContent: (content: ReactNode) => void;
  /** Changes when the host resizes, which moves the bottom-anchored composer. */
  readonly layoutVersion: number;
};

const ComposerPopoverHostContext = createContext<ComposerPopoverHostValue | null>(null);

export function useComposerPopoverHost() {
  return useContext(ComposerPopoverHostContext);
}

/**
 * Full-size layer around the composer for its popovers. Mount it inside the
 * composer's KeyboardStickyView: popovers placed here move with the composer
 * and sit inside a parent that covers them, so Android delivers their scroll
 * gestures. It wraps the composer because measureLayout needs an ancestor.
 * Pass `hidden` whenever the composer itself is hidden: popovers live outside
 * the composer's subtree, so they don't hide with it.
 */
export function ComposerPopoverHost(props: {
  readonly hidden: boolean;
  readonly children: ReactNode;
}) {
  const hostRef = useRef<ViewInstance>(null);
  const [content, setContent] = useState<ReactNode>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const value = useMemo(() => ({ hostRef, setContent, layoutVersion }), [layoutVersion]);

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
