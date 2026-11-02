import { useState } from "react";

import { setMarkdownTaskChecked } from "../files/filePreviewMode";

/**
 * Shows a toggled task at once and saves the rewritten body. The optimistic body holds until the
 * host's copy changes, and is dropped if the save fails.
 */
export function usePullRequestTaskToggle(
  body: string,
  save: ((body: string) => Promise<boolean>) | null,
) {
  const [pending, setPending] = useState<{ readonly base: string; readonly body: string } | null>(
    null,
  );
  const text = pending !== null && pending.base === body ? pending.body : body;
  if (save === null) return { text, onTaskListChange: undefined };
  return {
    text,
    onTaskListChange: ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
      const next = setMarkdownTaskChecked(text, markerOffset, checked);
      if (next === text) return;
      setPending({ base: body, body: next });
      void save(next).then((saved) => {
        if (!saved) setPending(null);
      });
    },
  };
}
