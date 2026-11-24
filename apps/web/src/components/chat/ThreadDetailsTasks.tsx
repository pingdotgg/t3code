import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef } from "react";
import { CheckIcon, ChevronRightIcon, CircleDashedIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { type ThreadTodoListEntry, useThreadTodoLists } from "../../state/entities";
import { Spinner } from "../ui/spinner";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  outlineTodoSteps,
  type TodoOutline,
  type TodoStatus,
  type TodoStep,
} from "./ThreadDetailsTasks.logic";

/** The agent's task lists for this thread, newest last, live while it runs and kept after. */
export function ThreadDetailsTasks(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const lists = useThreadTodoLists(scopeThreadRef(props.environmentId, props.threadId));
  if (lists.length === 0) return null;
  return <ThreadDetailsTasksLists lists={lists} />;
}

function ThreadDetailsTasksLists(props: { lists: ReadonlyArray<ThreadTodoListEntry> }) {
  const gt = useGT();
  const outlines = props.lists.map((list) => ({
    id: list.id,
    outline: outlineTodoSteps(list.steps),
  }));
  const done = outlines.reduce((sum, { outline }) => sum + outline.done, 0);
  const total = outlines.reduce((sum, { outline }) => sum + outline.total, 0);
  const listRef = useRef<HTMLDivElement>(null);
  const latestSteps = props.lists.at(-1)!.steps;
  const runningId = latestSteps.find((step) => step.status === "running")?.id;
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
  const earlier = outlines.slice(0, -1);
  const latest = outlines.at(-1)!;
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
      <div
        ref={listRef}
        data-thread-details-tasks-list
        className="max-h-[min(22rem,45dvh)] overflow-y-auto"
      >
        {earlier.map(({ id, outline }, index) => (
          <details key={id} data-task-list="earlier" className="group border-b border-border/60">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-2.5 py-1 text-xs leading-5 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-90"
              />
              <span className="min-w-0 flex-1">
                {gt("Earlier list {number}", {
                  number: index + 1,
                  $context: "task checklist: a folded task list from an earlier request",
                })}
              </span>
              <span className="text-2xs tabular-nums">
                {outline.done}/{outline.total}
              </span>
            </summary>
            <TodoOutlineList outline={outline} />
          </details>
        ))}
        <div data-task-list="latest" className={earlier.length > 0 ? "pt-1" : undefined}>
          <TodoOutlineList key={latest.id} outline={latest.outline} />
        </div>
      </div>
    </ThreadDetailsSection>
  );
}

function TodoOutlineList(props: { outline: TodoOutline }) {
  const { outline } = props;
  return (
    <ul className="m-0 list-none p-0">
      {outline.loose.map((step) => (
        <TaskRow key={step.id} step={step} />
      ))}
      {outline.phases.map((phase) => (
        <li key={phase.id} data-task-phase={phase.status} className="pt-1 first:pt-0">
          <div className="flex items-start gap-2.5 px-2.5 py-1 text-xs leading-5">
            <TaskIcon status={phase.status} />
            <span
              className={cn(
                "min-w-0 flex-1 break-words font-medium [overflow-wrap:anywhere]",
                phase.status === "pending" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              <span className="sr-only">
                <StatusLabel status={phase.status} />{" "}
              </span>
              {phase.title}
            </span>
            {phase.steps.length > 0 ? (
              <span aria-hidden className="text-2xs leading-5 text-muted-foreground tabular-nums">
                {phase.done}/{phase.steps.length}
              </span>
            ) : null}
          </div>
          {phase.steps.length > 0 ? (
            <ul className="m-0 list-none p-0 pl-4">
              {phase.steps.map((step) => (
                <TaskRow key={step.id} step={step} />
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TaskRow(props: { step: TodoStep }) {
  const { step } = props;
  return (
    <li
      data-task-status={step.status}
      className="flex items-start gap-2.5 px-2.5 py-1 text-xs leading-5"
    >
      <TaskIcon status={step.status} />
      <span
        className={cn(
          "min-w-0 flex-1 break-words [overflow-wrap:anywhere]",
          step.status === "completed" && "text-foreground/80",
          step.status === "running" && "font-medium text-foreground",
          step.status === "pending" && "text-muted-foreground",
        )}
      >
        <span className="sr-only">
          <StatusLabel status={step.status} />{" "}
        </span>
        {step.text}
      </span>
    </li>
  );
}

function TaskIcon(props: { status: TodoStatus }) {
  return (
    <span className="flex h-5 w-4 shrink-0 items-center justify-center">
      {props.status === "completed" ? (
        <CheckIcon aria-hidden className="size-3.5 text-success" />
      ) : props.status === "running" ? (
        <Spinner aria-hidden role={undefined} aria-label={undefined} size="sm" />
      ) : (
        <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground/70" />
      )}
    </span>
  );
}

function StatusLabel(props: { status: TodoStatus }) {
  const gt = useGT();
  return props.status === "completed"
    ? gt("Completed:", { $context: "task checklist step status" })
    : props.status === "running"
      ? gt("In progress:", { $context: "task checklist step status" })
      : gt("Pending:", { $context: "task checklist step status" });
}
