import type { OrbitTaskSummary } from "@t3tools/client-runtime/orbit-gateway";
import { use } from "react";

import { useLiveOrbitTask } from "~/orbit/tasks/liveOrbitTask";
import { openThreadTask } from "~/orbit/tasks/openThreadTask";
import { TaskRow } from "~/orbit/tasks/TaskCardButton";

import { TimelineRowCtx } from "./timelineRowContext";

/**
 * Stands in for the plain tool row: the created task as a list row, live. The tool result is
 * the snapshot shown until Orbit answers, or when it cannot be reached.
 */
export function TaskReceiptRow(props: { task: OrbitTaskSummary }) {
  const { threadRef } = use(TimelineRowCtx);
  const live = useLiveOrbitTask(props.task.id);
  const task = live ?? props.task;
  return (
    // Spacing between cards, and around them, comes from the row's section (WorkGroupSection).
    <div className="max-w-md">
      <TaskRow
        task={task}
        onOpen={() => {
          if (threadRef) openThreadTask(threadRef, task.id);
        }}
        onOpenPullRequest={(url) => {
          if (threadRef) openThreadTask(threadRef, task.id, url);
        }}
      />
    </div>
  );
}
