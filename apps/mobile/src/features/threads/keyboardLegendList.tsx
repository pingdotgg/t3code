import { KeyboardAvoidingLegendList } from "@legendapp/list/keyboard";
import type { AnimatedLegendListProps } from "@legendapp/list/reanimated";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { ChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import * as React from "react";
import { useCallback, useEffect, useRef, type ForwardedRef } from "react";
import { Keyboard, type Insets, type LayoutChangeEvent } from "react-native";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

interface KeyboardAwareLegendListProps<ItemT> extends Omit<
  AnimatedLegendListProps<ItemT>,
  "onScroll"
> {
  readonly anchoredEndSpace?: ChatListAnchoredEndSpace;
  readonly contentInsetEndAdjustment?: SharedValue<number>;
  readonly freeze?: SharedValue<boolean>;
  readonly keyboardLiftBehavior?: "always" | "whenAtEnd" | "never";
  readonly onScroll?: AnimatedLegendListProps<ItemT>["onScroll"];
  readonly contentInset?: Insets;
  readonly safeAreaInsetBottom?: number;
}

function assignRef(ref: ForwardedRef<LegendListRef>, value: LegendListRef | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}

function KeyboardAwareLegendListInner<ItemT>(
  props: KeyboardAwareLegendListProps<ItemT>,
  forwardedRef: ForwardedRef<LegendListRef>,
) {
  const {
    anchoredEndSpace,
    contentInsetEndAdjustment: _contentInsetEndAdjustment,
    freeze: _freeze,
    keyboardLiftBehavior: _keyboardLiftBehavior,
    ...listProps
  } = props;
  const listRef = useRef<LegendListRef | null>(null);
  const setListRef = useCallback(
    (value: LegendListRef | null) => {
      listRef.current = value;
      assignRef(forwardedRef, value);
    },
    [forwardedRef],
  );

  useEffect(() => {
    if (!anchoredEndSpace) {
      return;
    }
    void listRef.current
      ?.scrollToIndex({
        index: anchoredEndSpace.anchorIndex,
        viewOffset: anchoredEndSpace.anchorOffset,
        viewPosition: 0,
        animated: true,
      })
      .catch(() => undefined);
  }, [anchoredEndSpace]);

  return <KeyboardAvoidingLegendList ref={setListRef} {...listProps} />;
}

export const KeyboardAwareLegendList = React.forwardRef(KeyboardAwareLegendListInner) as <ItemT>(
  props: KeyboardAwareLegendListProps<ItemT> & React.RefAttributes<LegendListRef>,
) => React.ReactElement | null;

export function useKeyboardChatComposerInset(
  listRef: React.RefObject<LegendListRef | null>,
  _composerOverlayRef: React.RefObject<unknown>,
  estimatedOverlayHeight: number,
) {
  const contentInsetEndAdjustment = useSharedValue(estimatedOverlayHeight);

  useEffect(() => {
    contentInsetEndAdjustment.set(estimatedOverlayHeight);
    listRef.current?.reportContentInset({ bottom: estimatedOverlayHeight });
  }, [contentInsetEndAdjustment, estimatedOverlayHeight, listRef]);

  const onComposerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = Math.max(estimatedOverlayHeight, event.nativeEvent.layout.height);
      contentInsetEndAdjustment.set(nextHeight);
      listRef.current?.reportContentInset({ bottom: nextHeight });
    },
    [contentInsetEndAdjustment, estimatedOverlayHeight, listRef],
  );

  return { contentInsetEndAdjustment, onComposerLayout };
}

export function useKeyboardScrollToEnd(props: {
  readonly listRef: React.RefObject<LegendListRef | null>;
}) {
  const freeze = useSharedValue(false);
  const scrollMessageToEnd = useCallback(
    async (options: { readonly animated?: boolean; readonly closeKeyboard?: boolean } = {}) => {
      freeze.set(true);
      if (options.closeKeyboard ?? true) {
        Keyboard.dismiss();
      }
      try {
        await props.listRef.current?.scrollToEnd({ animated: options.animated ?? true });
      } finally {
        requestAnimationFrame(() => freeze.set(false));
      }
    },
    [freeze, props.listRef],
  );

  return { freeze, scrollMessageToEnd };
}
