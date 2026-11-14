import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";

import {
  COMPOSER_POPOVER_GAP,
  composerPopoverPlacement,
  useComposerPopoverHost,
} from "./ComposerPopoverHost";

type Frame = { readonly x: number; readonly y: number; readonly width: number };

/** Android only delivers drags inside parent bounds; bottom-full popover lists cannot scroll. */
export function ComposerPopoverAnchor(props: {
  readonly children: (overlapsComposer: boolean) => ReactNode;
}) {
  const host = useComposerPopoverHost();
  const anchorRef = useRef<ViewInstance>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const popoverHeight = host?.popoverHeight;
  const placement = composerPopoverPlacement(host);
  // A pinned popover's top sits `above` over the composer whatever its height.
  const pinnedAbove = placement?.pinnedToTop ? placement.above : null;
  const measuredHeightRef = useRef(0);

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
    if (frame === null) {
      host?.setContent(null);
      return;
    }
    // The host's top can sit above the screen while the keyboard lifts it, so the room
    // estimate, not the anchor's offset, bounds the height.
    const bottom = frame.y - COMPOSER_POPOVER_GAP;
    const pinnedToTop = placement?.pinnedToTop === true;
    const height = placement === null ? bottom : Math.min(bottom, placement.maxHeight);
    host?.setContent(
      <View
        pointerEvents="box-none"
        className={pinnedToTop ? "absolute justify-start" : "absolute justify-end"}
        style={{
          left: frame.x,
          width: frame.width,
          top: pinnedToTop ? bottom - placement.above : bottom - height,
          height: pinnedToTop ? placement.maxHeight : height,
        }}
      >
        <View
          className="shrink"
          onLayout={(event) => {
            measuredHeightRef.current = event.nativeEvent.layout.height;
            popoverHeight?.set(pinnedAbove ?? measuredHeightRef.current);
          }}
        >
          {props.children(pinnedToTop)}
        </View>
      </View>,
    );
  });

  // New room can leave the popover's own size unchanged, so no layout event reports it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reports the popover's height above the composer when the room estimate changes
  useEffect(() => {
    if (measuredHeightRef.current === 0) return;
    popoverHeight?.set(pinnedAbove ?? measuredHeightRef.current);
  }, [pinnedAbove, popoverHeight]);

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
    return (
      <View className="absolute inset-x-0 bottom-full z-10 mb-2">{props.children(false)}</View>
    );
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
