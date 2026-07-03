import { TextInputWrapper } from "expo-paste-input";
import { useImperativeHandle, useRef } from "react";
import { TextInput, type TextInput as RNTextInput } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { useNativePaste } from "../lib/useNativePaste";
import type { ComposerEditorProps } from "./T3ComposerEditor.types";

export function ComposerEditor({
  ref,
  skills: _skills,
  selection,
  onPasteImages,
  style,
  textStyle,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps) {
  const inputRef = useRef<RNTextInput>(null);
  const bodyText = useScaledTextRole("body");
  const foregroundColor = useThemeColor("--color-foreground");
  const placeholderColor = useThemeColor("--color-placeholder");
  const handlePaste = useNativePaste((uris) => onPasteImages?.(uris));

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      setSelection: (nextSelection) =>
        inputRef.current?.setSelection(nextSelection.start, nextSelection.end),
    }),
    [],
  );

  return (
    <TextInputWrapper onPaste={handlePaste} style={[{ minHeight: 0 }, style]}>
      <TextInput
        ref={inputRef}
        {...props}
        selection={selection}
        onSelectionChange={(event) => props.onSelectionChange?.(event.nativeEvent.selection)}
        multiline={props.multiline ?? true}
        placeholderTextColor={placeholderColor}
        style={[
          {
            flex: 1,
            minHeight: 0,
            color: foregroundColor,
            fontFamily: "DMSans_400Regular",
            ...bodyText,
            paddingVertical: contentInsetVertical,
          },
          textStyle,
        ]}
      />
    </TextInputWrapper>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";
