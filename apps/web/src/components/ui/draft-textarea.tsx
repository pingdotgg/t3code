"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
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

  useEffect(() => {
    if (document.activeElement instanceof HTMLTextAreaElement) return;
    setDraft(null);
  }, [value]);

  const commit = (next: string) => {
    setDraft(null);
    if (next !== value) {
      onCommit(next);
    }
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
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
      commit(draft ?? value);
      event.currentTarget.blur();
    }
  };

  const handleBlur = () => {
    if (discardedRef.current) {
      discardedRef.current = false;
      return;
    }
    commit(draft ?? value);
  };

  return (
    <Textarea
      {...rest}
      value={draft ?? value}
      onChange={handleChange}
      onFocus={() => setDraft(value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
