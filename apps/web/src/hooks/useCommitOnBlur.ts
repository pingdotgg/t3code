import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

export function useCommitOnBlur(
  value: string,
  onCommit: (next: string) => void,
  normalizeDraft?: (previous: string, next: string) => string,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const valueRef = useRef(value);
  const valueOnFocus = useRef(value);
  const onCommitRef = useRef(onCommit);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep latest committed value and callback for unmount flush
  useEffect(() => {
    valueRef.current = value;
    onCommitRef.current = onCommit;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flush pending draft on unmount before blur (closing settings or switching tabs)
  useEffect(
    () => () => {
      const pending = draftRef.current;
      if (pending !== null && pending !== valueOnFocus.current && pending !== valueRef.current) {
        draftRef.current = null;
        onCommitRef.current(pending);
      }
    },
    [],
  );

  return {
    value: draft ?? value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      const normalized = normalizeDraft
        ? normalizeDraft(draftRef.current ?? valueRef.current, next)
        : next;
      draftRef.current = normalized;
      setDraft(normalized);
    },
    onFocus: () => {
      valueOnFocus.current = value;
      draftRef.current = value;
      setDraft(value);
    },
    onBlur: () => {
      const next = draftRef.current ?? valueRef.current;
      draftRef.current = null;
      setDraft(null);
      if (next !== valueOnFocus.current && next !== valueRef.current) {
        onCommitRef.current(next);
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
