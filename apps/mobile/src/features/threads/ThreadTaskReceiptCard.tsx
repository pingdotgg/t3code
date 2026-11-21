import { StackActions, useNavigation } from "@react-navigation/native";
import type { OrbitTaskSummary } from "@t3tools/client-runtime/orbit-gateway";

import { useLiveOrbitTask } from "../tasks/liveOrbitTask";
import { useNow } from "../tasks/orbitTasks";
import { TaskRow } from "../tasks/TaskRows";
import { ThreadCardFace } from "./ThreadCardFace";
import { WorkLogBlock } from "./work-log-layout";

/**
 * Stands in for the plain tool row of an Orbit task-create call: the created task as the Tasks
 * tab's row, in a card like a subagent's. The tool result is the snapshot shown until Orbit
 * answers, or when it cannot be reached. A tap opens the task.
 */
export function ThreadTaskReceiptCard(props: { readonly task: OrbitTaskSummary }) {
  const navigation = useNavigation();
  const live = useLiveOrbitTask(props.task.id);
  const now = useNow(true);
  const task = live ?? props.task;
  return (
    <WorkLogBlock>
      <ThreadCardFace className="mb-2">
        <TaskRow
          card
          task={task}
          durationMs={live?.metrics.durationMs ?? null}
          now={now}
          onPress={() =>
            navigation.dispatch(StackActions.push("OrbitTask", { taskId: props.task.id }))
          }
        />
      </ThreadCardFace>
    </WorkLogBlock>
  );
}
