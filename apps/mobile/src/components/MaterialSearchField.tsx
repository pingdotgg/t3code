import type { RefObject } from "react";
import { Pressable, TextInput, type TextInputInstance, View } from "react-native";

import { SymbolView } from "./AppSymbol";

export function MaterialSearchField({
  inputRef,
  accessibilityLabel,
  clearAccessibilityLabel,
  placeholder,
  value,
  onChangeText,
}: {
  readonly inputRef: RefObject<TextInputInstance | null>;
  readonly accessibilityLabel: string;
  readonly clearAccessibilityLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
}) {
  return (
    <View className="h-12 min-w-0 flex-1 flex-row items-center gap-2 rounded-full border border-input-border bg-input px-3">
      <SymbolView name="magnifyingglass" size={18} tintColorClassName="accent-foreground-muted" />
      <TextInput
        ref={inputRef}
        accessibilityLabel={accessibilityLabel}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        placeholder={placeholder}
        placeholderTextColorClassName="accent-placeholder"
        selectionColorClassName="accent-focus/32"
        cursorColorClassName="accent-focus"
        selectionHandleColorClassName="accent-focus"
        className="min-w-0 flex-1 py-2 font-sans text-base text-foreground"
        value={value}
        onChangeText={onChangeText}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityLabel={clearAccessibilityLabel}
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => {
            onChangeText("");
            inputRef.current?.focus();
          }}
        >
          <SymbolView
            name="xmark.circle.fill"
            size={18}
            tintColorClassName="accent-foreground-muted"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
