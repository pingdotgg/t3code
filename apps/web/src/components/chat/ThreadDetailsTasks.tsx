import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef } from "react";
import { CheckIcon, CircleDashedIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { type ThreadTodoList, useThreadLatestTodoList } from "../../state/entities";
import { Spinner } from "../ui/spinner";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

type TodoStep = ThreadTodoList["steps"][number];

/** The agent's newest task checklist, live while it runs and kept after it ends. */
export function ThreadDetailsTasks(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const plan = useThreadLatestTodoList(scopeThreadRef(props.environmentId, props.threadId));
  if (plan === null) return null;
  return <ThreadDetailsTasksList steps={plan.steps} />;
}

function ThreadDetailsTasksList(props: { steps: ReadonlyArray<TodoStep> }) {
  const gt = useGT();
  const total = props.steps.length;
  const done = props.steps.filter((step) => step.status === "completed").length;
  const listRef = useRef<HTMLUListElement>(null);
  const runningId = props.steps.find((step) => step.status === "running")?.id;
  // Long plans scroll inside the card; keep the step in progress in view, without moving the panel.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the list's DOM scroll position on the running step
  useEffect(() => {
    const list = listRef.current;
    if (!list || runningId === undefined) return;
    const row = list.querySelector<HTMLElement>(`[data-task-status="running"]`);
    if (!row) return;
    const listBox = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < listBox.top || rowBox.bottom > listBox.bottom) {
      const top = rowBox.top - listBox.top + list.scrollTop;
      list.scrollTop = Math.max(0, top - (list.clientHeight - rowBox.height) / 2);
    }
  }, [runningId]);
  return (
    <ThreadDetailsSection
      headingId="thread-details-tasks-heading"
      title={gt("Tasks", { $context: "thread details heading: the agent's task checklist" })}
      separated={false}
      actions={
        <>
          <span aria-hidden className="text-2xs text-muted-foreground tabular-nums">
            {done}/{total}
          </span>
          <span className="sr-only">{gt("{done} of {total} tasks complete", { done, total })}</span>
        </>
      }
    >
      <ul
        ref={listRef}
        data-thread-details-tasks-list
        className="m-0 max-h-[min(22rem,45dvh)] list-none overflow-y-auto p-0"
      >
        {props.steps.map((step) => (
          <li
            key={step.id}
            data-task-status={step.status}
            className="flex items-start gap-2.5 px-2.5 py-1 text-xs leading-5"
          >
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
              {step.status === "completed" ? (
                <CheckIcon aria-hidden className="size-3.5 text-success" />
              ) : step.status === "running" ? (
                <Spinner aria-hidden role={undefined} aria-label={undefined} size="sm" />
              ) : (
                <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground/70" />
              )}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words [overflow-wrap:anywhere]",
                step.status === "completed" && "text-foreground/80",
                step.status === "running" && "font-medium text-foreground",
                step.status === "pending" && "text-muted-foreground",
              )}
            >
              <span className="sr-only">
                {step.status === "completed"
                  ? gt("Completed:", { $context: "task checklist step status" })
                  : step.status === "running"
                    ? gt("In progress:", { $context: "task checklist step status" })
                    : gt("Pending:", { $context: "task checklist step status" })}{" "}
              </span>
              {step.text}
            </span>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
