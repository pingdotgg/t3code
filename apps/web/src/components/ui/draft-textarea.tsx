"use client";

import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { Textarea, type TextareaProps } from "./textarea";

export type DraftTextareaProps = Omit<TextareaProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Multiline `<Textarea>` that buffers keystrokes locally and invokes
 * `onCommit` only when the user finishes editing (blur or ⌘+Enter).
 * Escape discards the draft. Same rationale as `DraftInput`: avoids a
 * settings-wide re-render per keystroke on long fields like prompts and
 * vocabularies.
 */
export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const discardedRef = useRef(false);
  const bag = useCommitOnBlur(value, onCommit);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    bag.onChange(event as unknown as ChangeEvent<HTMLInputElement>);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      // `blur()` below fires `onBlur` synchronously while this closure
      // still holds the pre-Escape draft; flag the discard so the blur
      // handler skips the commit instead of persisting cancelled text.
      discardedRef.current = true;
      setDraft(null);
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  const handleBlur = () => {
    if (discardedRef.current) {
      discardedRef.current = false;
      setDraft(null);
      return;
    }
    bag.onBlur();
    setDraft(null);
  };

  return (
    <Textarea
      {...rest}
      value={draft ?? bag.value}
      onChange={handleChange}
      onFocus={() => setDraft(value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
