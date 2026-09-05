"use client";

import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Textarea, type TextareaProps } from "./textarea";

export type DraftTextareaProps = Omit<TextareaProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Multiline `<Textarea>` that buffers keystrokes locally and invokes
 * `onCommit` only when the user finishes editing (blur or Escape/⌘+Enter).
 * Same rationale as `DraftInput`: avoids a settings-wide re-render per
 * keystroke on long fields like prompts and vocabularies.
 */
export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
  const [draft, setDraft] = useState<string | null>(null);

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

  return (
    <Textarea
      {...rest}
      value={draft ?? value}
      onChange={handleChange}
      onFocus={() => setDraft(value)}
      onBlur={() => commit(draft ?? value)}
      onKeyDown={handleKeyDown}
    />
  );
}
