import { useRef, useState } from "react";

import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskEdits";

/**
 * Shows a toggled task at once and saves each rewritten body in click order. The shown body holds
 * until the saves drain and the host's copy changes. A failed save drops the saves queued behind
 * it, since each carries the failed change, and `onSettled` then brings back the host's copy.
 */
export function usePullRequestTaskToggle(
  body: string,
  save: ((body: string) => Promise<boolean>) | null,
  onSettled: () => void,
) {
  const [pending, setPending] = useState<{
    readonly base: string;
    readonly body: string;
    readonly settled: boolean;
  } | null>(null);
  const queue = useRef({ tail: Promise.resolve(), generation: 0, waiting: 0 });
  // Once the host's copy moves on, forget the toggles so a later revert to `base` cannot revive them.
  if (pending !== null && pending.settled && pending.base !== body) setPending(null);
  const shown = pending !== null && (!pending.settled || pending.base === body) ? pending : null;
  const text = shown?.body ?? body;
  if (save === null) return { text, onTaskListChange: undefined };
  return {
    text,
    onTaskListChange: ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
      const next = setMarkdownTaskChecked(text, markerOffset, checked);
      if (next === text) return;
      setPending({ base: shown?.base ?? body, body: next, settled: false });
      const current = queue.current;
      const generation = current.generation;
      current.waiting += 1;
      current.tail = current.tail
        .then(async () => {
          if (generation !== current.generation) return;
          if (await save(next)) return;
          current.generation += 1;
          setPending(null);
        })
        .then(() => {
          current.waiting -= 1;
          if (current.waiting > 0) return;
          setPending((latest) => (latest === null ? null : { ...latest, settled: true }));
          onSettled();
        });
    },
  };
}
