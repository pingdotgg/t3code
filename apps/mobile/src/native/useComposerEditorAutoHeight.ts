import { useMemo, useState } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import {
  composerEditorLaidOutHeight,
  numericStyleLength,
  verticalPaddingFromViewStyle,
} from "./composerEditorLayout";

const CONTENT_HEIGHT_EPSILON = 0.5;

/** Keep the last height when the native sample is a sub-pixel echo. */
function coalesceContentHeight(current: number | null, nextHeight: number): number {
  return current != null && Math.abs(current - nextHeight) < CONTENT_HEIGHT_EPSILON
    ? current
    : nextHeight;
}

/** Grow an expanded composer from native content height within min/max style bounds. */
export function useComposerEditorAutoHeight(style: StyleProp<ViewStyle> | undefined) {
  const flatStyle = StyleSheet.flatten(style) ?? {};
  const minHeight = numericStyleLength(flatStyle.minHeight);
  const maxHeight = numericStyleLength(flatStyle.maxHeight);
  const height = numericStyleLength(flatStyle.height);
  const verticalPadding = verticalPaddingFromViewStyle(flatStyle);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  /** Accept a native content-height sample unless it is a sub-pixel echo. */
  function onContentHeight(nextHeight: number) {
    if (!Number.isFinite(nextHeight) || nextHeight < 0) {
      return;
    }
    /** Store a coalesced native content-height sample. */
    function storeCoalescedContentHeight(current: number | null): number {
      return coalesceContentHeight(current, nextHeight);
    }
    setContentHeight(storeCoalescedContentHeight);
  }

  /** Concrete Yoga height once the expanded editor has a content measurement. */
  function computeLaidOutHeight() {
    if (typeof height === "number" || (minHeight === undefined && maxHeight === undefined)) {
      return undefined;
    }
    if (contentHeight == null) {
      return undefined;
    }
    return composerEditorLaidOutHeight({
      contentHeight,
      minHeight,
      maxHeight,
      verticalPadding,
    });
  }
  const laidOutHeight = useMemo(computeLaidOutHeight, [
    contentHeight,
    height,
    maxHeight,
    minHeight,
    verticalPadding,
  ]);

  /** Incoming style, plus a measured height when auto-height applies. */
  function computeResolvedStyle() {
    return laidOutHeight == null ? style : [style, { height: laidOutHeight }];
  }
  const resolvedStyle = useMemo(computeResolvedStyle, [laidOutHeight, style]);

  return { onContentHeight, resolvedStyle };
}
