import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";

import { useComposerPopoverHost } from "./ComposerPopoverHost";

const COMPOSER_GAP = 8;

type Frame = { readonly x: number; readonly y: number; readonly width: number };

/**
 * Places a composer popover just above the composer. Android only delivers
 * drags to views inside their parent's bounds, so a popover hung above the
 * composer with `bottom-full` takes taps but its list never scrolls. Render it
 * into ComposerPopoverHost instead, which shares the composer's keyboard
 * transform, so only the composer's resting layout needs measuring.
 */
export function ComposerPopoverAnchor(props: { readonly children: ReactNode }) {
  const host = useComposerPopoverHost();
  const anchorRef = useRef<ViewInstance>(null);
  const [frame, setFrame] = useState<Frame | null>(null);

  const measure = () => {
    const hostView = host?.hostRef.current;
    if (!hostView) {
      return;
    }
    anchorRef.current?.measureLayout(hostView, (x, y, width) => {
      setFrame((current) =>
        current?.x === x && current.y === y && current.width === width ? current : { x, y, width },
      );
    });
  };

  // No dependency array: the composer re-renders when its padding or expanded
  // state changes, which moves it without resizing the anchor, so measure and
  // re-project after every render.
  useEffect(() => {
    measure();
    host?.setContent(
      frame === null ? null : (
        <View
          pointerEvents="box-none"
          className="absolute top-0 justify-end"
          style={{ left: frame.x, width: frame.width, height: frame.y - COMPOSER_GAP }}
        >
          {props.children}
        </View>
      ),
    );
  });

  const setHostContent = host?.setContent;
  useEffect(() => () => setHostContent?.(null), [setHostContent]);

  if (host === null) {
    return <View className="absolute inset-x-0 bottom-full z-10 mb-2">{props.children}</View>;
  }

  // Covers the composer, so its onLayout fires whenever the composer resizes.
  return (
    <View
      ref={anchorRef}
      collapsable={false}
      pointerEvents="none"
      className="absolute inset-0"
      onLayout={measure}
    />
  );
}
