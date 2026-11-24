import { useState } from "react";

import {
  createTaskListSaveQueue,
  settleTaskListDraft,
  startTaskListToggle,
  taskListDraftInForce,
  type TaskListDraft,
} from "@t3tools/client-runtime/pull-request-editing";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskEdits";

/**
 * A comment body with task ticks shown at once and saved in click order. An editor opens from
 * `text`, and only once `saving` is over, so a queued tick cannot land after the edit.
 */
export function usePullRequestTaskToggle(
  body: string,
  save: ((body: string) => Promise<boolean>) | null,
  onSettled: () => void,
) {
  const [draft, setDraft] = useState<TaskListDraft | null>(null);
  const [enqueue] = useState(createTaskListSaveQueue);
  const kept = taskListDraftInForce(draft, body);
  if (kept !== draft) setDraft(kept);
  const text = kept?.body ?? body;
  const saving = kept !== null && !kept.settled;
  if (save === null) return { text, saving, onTaskListChange: undefined };
  return {
    text,
    saving,
    onTaskListChange: ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
      const next = setMarkdownTaskChecked(text, markerOffset, checked);
      if (next === text) return;
      setDraft(startTaskListToggle(kept, body, next));
      enqueue(() => save(next), {
        failed: () => setDraft(null),
        drained: () => {
          setDraft(settleTaskListDraft);
          onSettled();
        },
      });
    },
  };
}
