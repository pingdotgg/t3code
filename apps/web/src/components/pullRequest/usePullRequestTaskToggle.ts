import { useRef, useState } from "react";

import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";

/**
 * Shows toggled tasks at once and saves each rewritten body in click order. The optimistic body
 * holds until the queue drains and the host's copy changes. A failed save cancels the saves queued
 * behind it, since each carries the failed change, and the final refresh shows the host's copy.
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
  // Once the host's copy moves on, forget the burst so a later revert to `base` cannot revive it.
  if (pending !== null && pending.settled && pending.base !== body) setPending(null);
  const showPending = pending !== null && (!pending.settled || pending.base === body);
  const text = showPending ? pending.body : body;
  if (save === null) return { text, onTaskListChange: undefined };
  return {
    text,
    onTaskListChange: ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
      const next = setMarkdownTaskChecked(text, markerOffset, checked);
      if (next === text) return;
      setPending({ base: showPending ? pending.base : body, body: next, settled: false });
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
