import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrbitTaskSummary } from "@t3tools/client-runtime/orbit-gateway";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useLiveOrbitTask } from "~/orbit/tasks/liveOrbitTask";
import { openThreadTask } from "~/orbit/tasks/openThreadTask";
import { TaskRow } from "~/orbit/tasks/TaskCardButton";
import { useQuietThreadVisibleTurnItems } from "../../state/entities";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { threadCreatedTasks } from "./TimelineTaskReceipt.logic";

function ThreadTaskRow(props: {
  snapshot: OrbitTaskSummary;
  onOpen: (taskId: number) => void;
  onOpenPullRequest: (taskId: number, url: string) => void;
}) {
  // The tool result is the snapshot until Orbit answers.
  const task = useLiveOrbitTask(props.snapshot.id) ?? props.snapshot;
  return (
    <li className="list-none">
      <TaskRow
        task={task}
        onOpen={() => props.onOpen(task.id)}
        onOpenPullRequest={(url) => props.onOpenPullRequest(task.id, url)}
      />
    </li>
  );
}

/** The Orbit tasks this thread created, from its task-create tool calls. Hidden while there are none. */
export function ThreadTasksPanel(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const gt = useGT();
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const tasks = threadCreatedTasks(useQuietThreadVisibleTurnItems(ref));
  if (tasks.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-tasks-heading"
      title={gt("Tasks", { $context: "thread details section: Orbit tasks this thread created" })}
      data-thread-tasks-panel
    >
      <ul
        aria-label={gt("Tasks created in this thread")}
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0"
      >
        {tasks.map((task) => (
          <ThreadTaskRow
            key={task.id}
            snapshot={task}
            onOpen={(taskId) => openThreadTask(ref, taskId)}
            onOpenPullRequest={(taskId, url) => openThreadTask(ref, taskId, url)}
          />
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
