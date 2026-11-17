import {
  orbitTaskEnvironment,
  orbitTaskLabel,
  type OrbitTaskLabelTone,
  type OrbitTasksPage,
  type OrbitTasksResult,
  type OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";
import { ChevronLeftIcon, ListTodoIcon, LockIcon, UnplugIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";

import { loadOrbitTasksClient, orbitTasksAvailability } from "./orbitTasksClient";
import { taskCardDetail, tasksBoardLanes, tasksErrorNotice } from "./tasksBoard.logic";
import { tasksPanelActions, useTasksNavigation } from "./tasksPanelStore";

type TaskListState = { readonly status: "loading" } | OrbitTasksResult<OrbitTasksPage>;

/** The board's tasks. Re-reads quietly on invalidation, keeping what it shows until the answer. */
function useOrbitTaskList(orbitProjectId: number | null) {
  const [state, setState] = useState<TaskListState>({ status: "loading" });
  const latestRequest = useRef(0);
  const reload = useStableCallback((projectId: number | null, quiet: boolean) => {
    const request = ++latestRequest.current;
    const settle = (next: TaskListState) => {
      if (request === latestRequest.current) setState(next);
    };
    if (!quiet) settle({ status: "loading" });
    void loadOrbitTasksClient().then((client) =>
      client
        ? client
            .listTasks(projectId === null ? { limit: 100 } : { project: projectId, limit: 100 })
            .then(settle)
        : settle({ status: "error", reason: "unreachable", message: "No Orbit Gateway here." }),
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads Orbit's task list for the panel's project and re-reads on the client's invalidation notices
  useEffect(() => {
    reload(orbitProjectId, false);
    let stop: (() => void) | null = null;
    let disposed = false;
    void loadOrbitTasksClient().then((client) => {
      if (client && !disposed) stop = client.onInvalidate(() => reload(orbitProjectId, true));
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [reload, orbitProjectId]);
  return { state, retry: () => reload(orbitProjectId, false) };
}

/**
 * The Orbit Tasks app in the right panel. `orbitProjectId` scopes the list to the thread's Orbit
 * Project; null lists every task this Node may read. Navigation lives in tasksPanelStore.
 */
export function TasksPanel(props: { threadKey: string; orbitProjectId: number | null }) {
  const availability = orbitTasksAvailability();
  if (!availability.available) {
    return (
      <TasksNotice icon={<UnplugIcon />} title="Tasks are unavailable" text={availability.reason} />
    );
  }
  return <TasksPanelContent {...props} />;
}

function TasksPanelContent(props: { threadKey: string; orbitProjectId: number | null }) {
  const { state, retry } = useOrbitTaskList(props.orbitProjectId);
  const navigation = useTasksNavigation(props.threadKey);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner size="md" tone="muted" />
      </div>
    );
  }
  if (state.status === "error") {
    const notice = tasksErrorNotice(state.reason);
    return (
      <TasksNotice
        icon={notice.kind === "access" ? <LockIcon /> : <UnplugIcon />}
        title={notice.title}
        text={state.message}
        action={
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        }
      />
    );
  }
  const { tasks } = state.value;
  if (navigation.view === "task" && navigation.taskId !== null) {
    return (
      <TaskDetailPlaceholder
        threadKey={props.threadKey}
        task={tasks.find((task) => task.id === navigation.taskId) ?? null}
        scrollTop={navigation.detailScrollTop}
      />
    );
  }
  if (tasks.length === 0) {
    return (
      <TasksNotice
        icon={<ListTodoIcon />}
        title="No tasks"
        text="Tasks Orbit runs for this project show here."
      />
    );
  }
  return <TasksBoard threadKey={props.threadKey} tasks={tasks} scroll={navigation.boardScroll} />;
}

function TasksNotice(props: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <Empty className="min-h-0 overflow-y-auto">
      <EmptyMedia variant="icon">{props.icon}</EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.text}</EmptyDescription>
      </EmptyHeader>
      {props.action}
    </Empty>
  );
}

/** Puts a remounted scroller back where the store says, once, without moving focus. */
function useRestoredScroll(top: number, left: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [initial] = useState({ top, left });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the DOM scroll position saved before the tab unmounted
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = initial.top;
    ref.current.scrollLeft = initial.left;
  }, [initial]);
  return ref;
}

/** Backlog, To do, In progress, Done side by side. Read-only: Orbit owns task state. */
function TasksBoard(props: {
  threadKey: string;
  tasks: ReadonlyArray<OrbitTaskSummary>;
  scroll: { readonly top: number; readonly left: number };
}) {
  const scrollRef = useRestoredScroll(props.scroll.top, props.scroll.left);
  return (
    <div
      ref={scrollRef}
      onScrollEnd={(event) =>
        tasksPanelActions().saveBoardScroll(
          props.threadKey,
          event.currentTarget.scrollTop,
          event.currentTarget.scrollLeft,
        )
      }
      className="scrollbar-inset flex min-h-0 flex-1 items-start gap-2 overflow-auto px-2 pb-2"
    >
      {tasksBoardLanes(props.tasks).map((lane) => (
        <section
          key={lane.id}
          aria-label={lane.label}
          className="flex min-w-48 flex-1 basis-0 flex-col"
        >
          <div className="flex h-9 shrink-0 items-center justify-between px-2.5 text-ui text-muted-foreground">
            <span className="font-medium">{lane.label}</span>
            <span className="tabular-nums">{lane.tasks.length}</span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {lane.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onOpen={() => tasksPanelActions().openTask(props.threadKey, task.id)}
              />
            ))}
            {lane.tasks.length === 0 ? (
              <li className="rounded-lg border border-dashed border-(--shell-divider)! px-3 py-4 text-center text-ui text-muted-foreground">
                Nothing here
              </li>
            ) : null}
          </ul>
        </section>
      ))}
    </div>
  );
}

const TONE_DOT: Record<OrbitTaskLabelTone, string> = {
  info: "bg-info",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};

const TONE_TEXT: Record<OrbitTaskLabelTone, string> = {
  info: "text-muted-foreground",
  warning: "text-warning-foreground",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

function TaskCard(props: { task: OrbitTaskSummary; onOpen: () => void }) {
  const label = orbitTaskLabel(props.task);
  return (
    <li>
      <button
        type="button"
        onClick={props.onOpen}
        className="flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border border-(--shell-divider-header)! px-3 py-2.5 text-left transition-colors hover:bg-(--shell-highlight) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
      >
        <span className="text-ui font-medium text-foreground [overflow-wrap:anywhere]">
          {props.task.title}
        </span>
        {label ? (
          <span className={cn("flex items-center gap-1.5 text-ui", TONE_TEXT[label.tone])}>
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[label.tone])}
            />
            {label.label}
          </span>
        ) : null}
        <span className="truncate text-ui text-muted-foreground tabular-nums">
          {taskCardDetail(props.task)}
        </span>
      </button>
    </li>
  );
}

const ENVIRONMENT_TEXT = {
  "not-started": "Not started yet.",
  disposed: "The task's workspace was removed.",
  stopped: "The task's workspace is asleep.",
  unreachable: "The task's conversations are not reachable from this device.",
} as const;

/** Slice 2 replaces this with the task brief, subtasks and agents. */
function TaskDetailPlaceholder(props: {
  threadKey: string;
  task: OrbitTaskSummary | null;
  scrollTop: number;
}) {
  const scrollRef = useRestoredScroll(props.scrollTop, 0);
  const environment = props.task ? orbitTaskEnvironment(props.task) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Tasks path"
        className="flex h-9 shrink-0 items-center gap-1 border-b border-(--shell-divider)! px-2 text-ui"
      >
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => tasksPanelActions().showBoard(props.threadKey)}
        >
          <ChevronLeftIcon aria-hidden />
          Tasks
        </Button>
        {props.task ? (
          <>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            <span className="min-w-0 truncate px-1 text-foreground">{props.task.title}</span>
          </>
        ) : null}
      </nav>
      <div
        ref={scrollRef}
        onScrollEnd={(event) =>
          tasksPanelActions().saveDetailScroll(props.threadKey, event.currentTarget.scrollTop)
        }
        className="scrollbar-inset min-h-0 flex-1 overflow-y-auto p-4 text-ui text-muted-foreground"
      >
        {environment === null
          ? "This task is no longer available."
          : environment.kind === "ready"
            ? null
            : ENVIRONMENT_TEXT[environment.kind]}
      </div>
    </div>
  );
}
