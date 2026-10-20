import { useLayoutEffect, useRef } from "react";
import type { TextInputInstance, TextInputSelectionChangeEvent } from "react-native";

/** Insert uploaded markdown at the native text selection, then return focus to the composer. */
export function useReviewAttachmentInsertion(value: string, onChange: (value: string) => void) {
  const input = useRef<TextInputInstance>(null);
  const selection = useRef({ start: value.length, end: value.length });
  const latest = useRef({ value, onChange });
  useLayoutEffect(() => {
    latest.current = { value, onChange };
  }, [value, onChange]);
  const onSelectionChange = (event: TextInputSelectionChangeEvent) => {
    selection.current = event.nativeEvent.selection;
  };
  const insert = (markdown: string) => {
    const { value, onChange } = latest.current;
    const start = Math.min(selection.current.start, value.length);
    const end = Math.min(selection.current.end, value.length);
    const before = value.slice(0, start);
    const after = value.slice(end);
    const added = `${before && !before.endsWith("\n\n") ? "\n\n" : ""}${markdown}${after && !after.startsWith("\n\n") ? "\n\n" : ""}`;
    const next = `${before}${added}${after}`;
    const caret = start + added.length;
    latest.current = { value: next, onChange };
    selection.current = { start: caret, end: caret };
    onChange(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setNativeProps({ selection: { start: caret, end: caret } });
    });
  };
  return { inputProps: { ref: input, onSelectionChange }, insert };
}
