import { useState, type RefObject } from "react";
import { Pressable, TextInput, type TextInputInstance, View } from "react-native";

import { SymbolView } from "./AppSymbol";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

export interface SearchFieldProps {
  readonly autoFocus?: boolean;
  readonly inputRef: RefObject<TextInputInstance | null>;
  readonly accessibilityLabel: string;
  readonly clearAccessibilityLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
}

export function SearchField({
  inputRef,
  autoFocus = true,
  accessibilityLabel,
  clearAccessibilityLabel,
  placeholder,
  value,
  onChangeText,
}: SearchFieldProps) {
  const { scale, mediumIconSize } = useAndroidControlSizing();
  const [text, setText] = useState(value);
  const [previousValue, setPreviousValue] = useState(value);
  if (previousValue !== value) {
    setPreviousValue(value);
    setText(value);
  }
  const changeText = (next: string) => {
    // The workspace header receives its props a commit later. Echo native input immediately
    // so TextInput cannot restore the old query and cancel an IME's composing span.
    setText(next);
    onChangeText(next);
  };
  return (
    <View
      className="min-w-0 flex-1 flex-row items-center rounded-full border border-input-border bg-input"
      style={{
        minHeight: Math.max(48, 42 * scale),
        gap: 7 * scale,
        paddingHorizontal: 10.5 * scale,
      }}
    >
      <SymbolView
        name="magnifyingglass"
        size={mediumIconSize}
        tintColorClassName="accent-foreground-muted"
      />
      <TextInput
        ref={inputRef}
        accessibilityLabel={accessibilityLabel}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        placeholder={placeholder}
        placeholderTextColorClassName="accent-placeholder"
        selectionColorClassName="accent-focus/32"
        cursorColorClassName="accent-focus"
        selectionHandleColorClassName="accent-focus"
        className="min-w-0 flex-1 font-sans text-base text-foreground"
        style={{ minHeight: Math.max(48, 42 * scale), paddingVertical: 7 * scale }}
        value={text}
        onChangeText={changeText}
      />
      {text.length > 0 ? (
        <Pressable
          accessibilityLabel={clearAccessibilityLabel}
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => {
            changeText("");
            inputRef.current?.focus();
          }}
        >
          <SymbolView
            name="xmark.circle.fill"
            size={mediumIconSize}
            tintColorClassName="accent-foreground-muted"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
