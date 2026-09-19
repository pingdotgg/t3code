import { TextInputWrapper } from "expo-paste-input";
import { useImperativeHandle, useRef } from "react";
import { TextInput, type TextInput as RNTextInput } from "react-native";

import { firstStrongDirection } from "@t3tools/mobile-markdown-text/markdown";
import { useFontFamily } from "../lib/useFontFamily";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { useNativePaste } from "../lib/useNativePaste";
import type { ComposerEditorProps } from "./T3ComposerEditor.types";

export function ComposerEditor({
  ref,
  skills: _skills,
  selection,
  onPasteImages,
  onPasteText: _onPasteText,
  style,
  textStyle,
  contentInsetVertical = 0,
  singleLineCentered: _singleLineCentered,
  enterBehavior: _enterBehavior,
  readOnly = false,
  ...props
}: ComposerEditorProps) {
  const inputRef = useRef<RNTextInput>(null);
  const bodyText = useScaledTextRole("body");
  const fontFamily = useFontFamily("regular");
  const handlePaste = useNativePaste((uris) => onPasteImages?.(uris));
  // Live composer direction: the draft's first strong letter decides (plain
  // first-strong — while typing, follow what the user actually typed; empty
  // resets to LTR). `writingDirection` is iOS-only; `textAlign` covers both.
  const writingDirection = firstStrongDirection(props.value);

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
        editable={(props.editable ?? true) && !readOnly}
        selection={selection}
        onSelectionChange={(event) => props.onSelectionChange?.(event.nativeEvent.selection)}
        multiline={props.multiline ?? true}
        placeholderTextColorClassName={"accent-placeholder"}
        className="text-foreground"
        style={[
          {
            flex: 1,
            minHeight: 0,
            fontFamily,
            ...bodyText,
            paddingVertical: contentInsetVertical,
          },
          textStyle,
          // Direction is the draft's, not the caller's — kept last so it can't
          // be overridden by a `textAlign`/`writingDirection` in `textStyle`.
          {
            textAlign: writingDirection === "rtl" ? "right" : "left",
            writingDirection,
          },
        ]}
      />
    </TextInputWrapper>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
  ComposerTextPaste,
} from "./T3ComposerEditor.types";
