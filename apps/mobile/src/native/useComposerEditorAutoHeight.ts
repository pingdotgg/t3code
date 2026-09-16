import { useCallback, useMemo, useState } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import {
  composerEditorLaidOutHeight,
  numericStyleLength,
  verticalPaddingFromViewStyle,
} from "./composerEditorLayout";

const CONTENT_HEIGHT_EPSILON = 0.5;

export function useComposerEditorAutoHeight(
  style: StyleProp<ViewStyle> | undefined,
  options?: { readonly includeVerticalPadding?: boolean },
) {
  const flatStyle = StyleSheet.flatten(style) ?? {};
  const minHeight = numericStyleLength(flatStyle.minHeight);
  const maxHeight = numericStyleLength(flatStyle.maxHeight);
  const height = numericStyleLength(flatStyle.height);
  const verticalPadding =
    options?.includeVerticalPadding === false ? 0 : verticalPaddingFromViewStyle(flatStyle);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  const onContentHeight = useCallback((nextHeight: number) => {
    if (!Number.isFinite(nextHeight) || nextHeight < 0) {
      return;
    }
    setContentHeight((current) =>
      current != null && Math.abs(current - nextHeight) < CONTENT_HEIGHT_EPSILON
        ? current
        : nextHeight,
    );
  }, []);

  const laidOutHeight = useMemo(() => {
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
  }, [contentHeight, height, maxHeight, minHeight, verticalPadding]);

  const resolvedStyle = useMemo(
    () => (laidOutHeight == null ? style : [style, { height: laidOutHeight }]),
    [laidOutHeight, style],
  );

  return { onContentHeight, resolvedStyle };
}
