import { useState } from "react";
import { observeComposerPromptLayout } from "./observeComposerPromptLayout";

/** Tracks native line wrapping for the mobile resting state. */
export function useComposerMultilinePrompt(): readonly [
  boolean,
  (body: HTMLElement | null) => (() => void) | undefined,
] {
  const [isMultiline, setIsMultiline] = useState(false);
  return [
    isMultiline,
    (body) => (body ? observeComposerPromptLayout(body, setIsMultiline) : undefined),
  ] as const;
}
