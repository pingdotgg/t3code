import { type ChangeEvent, type KeyboardEvent, useRef, useState } from "react";

export function useCommitOnBlur(
  value: string,
  onCommit: (next: string) => void,
  normalizeDraft?: (previous: string, next: string) => string,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const valueOnFocus = useRef(value);

  return {
    value: draft ?? value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setDraft(normalizeDraft ? normalizeDraft(draft ?? value, next) : next);
    },
    onFocus: () => {
      valueOnFocus.current = value;
      setDraft(value);
    },
    onBlur: () => {
      const next = draft ?? value;
      setDraft(null);
      if (next !== valueOnFocus.current && next !== value) {
        onCommit(next);
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      }
    },
  };
}
