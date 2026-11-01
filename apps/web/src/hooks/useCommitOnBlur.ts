import { type ChangeEvent, type KeyboardEvent, useRef, useState } from "react";

export function useCommitOnBlur(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  const valueOnFocus = useRef(value);

  return {
    value: draft ?? value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
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
