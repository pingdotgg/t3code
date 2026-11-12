import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";

import { useComposerPopoverHost } from "./ComposerPopoverHost";

const COMPOSER_GAP = 8;

type Frame = { readonly x: number; readonly y: number; readonly width: number };

/** Android only delivers drags inside parent bounds; bottom-full popover lists cannot scroll. */
export function ComposerPopoverAnchor(props: { readonly children: ReactNode }) {
  const host = useComposerPopoverHost();
  const anchorRef = useRef<ViewInstance>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const popoverHeight = host?.popoverHeight;

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

  // Measure every render: composer padding or expansion can move the anchor without resizing it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the anchor view after every commit and hands its popover content to the composer popover host
  useEffect(() => {
    measure();
    host?.setContent(
      frame === null ? null : (
        <View
          pointerEvents="box-none"
          className="absolute top-0 justify-end"
          style={{ left: frame.x, width: frame.width, height: frame.y - COMPOSER_GAP }}
        >
          <View
            onLayout={(event) => {
              popoverHeight?.set(event.nativeEvent.layout.height);
            }}
          >
            {props.children}
          </View>
        </View>
      ),
    );
  });

  const setHostContent = host?.setContent;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the popover host's content and shared height value when the anchor unmounts
  useEffect(
    () => () => {
      setHostContent?.(null);
      popoverHeight?.set(0);
    },
    [setHostContent, popoverHeight],
  );

  if (host === null) {
    return <View className="absolute inset-x-0 bottom-full z-10 mb-2">{props.children}</View>;
  }

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
