import {
  ORBIT_TASK_LANES,
  orbitTaskLabel,
  orbitTaskLane,
  type OrbitTaskLane,
  type OrbitTasksPage,
  type OrbitTasksResult,
  type OrbitTaskSummary,
  type OrbitTasksLiveStatus,
} from "@t3tools/client-runtime/orbit-gateway";
import {
  CircleAlertIcon,
  CircleDashedIcon,
  ListTodoIcon,
  LockIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ProjectMonogram } from "~/components/ProjectMonogram";
import { ToolbarGroup } from "~/components/ToolbarGroup";
import { resolvePullRequestState } from "~/components/pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { PROJECT_ICON_COLORS } from "~/projectIconColors";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { TaskDetail } from "./TaskDetail";
import { INPUT_TONE } from "./taskDetail.logic";
import {
  followTasksUpdates,
  loadOrbitTasksClient,
  orbitTasksAvailability,
} from "./orbitTasksClient";
import { taskCardDetail, tasksBoardLanes, tasksErrorNotice } from "./tasksBoard.logic";
import {
  tasksPanelActions,
  useTasksBoardQuery,
  useTasksLaneScroll,
  useTasksNavigation,
  useTasksBoardLanes,
} from "./tasksPanelStore";

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
    return loadOrbitTasksClient().then((client) =>
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
  // Same surface as the file and editor tabs beside it.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {availability.available ? (
        <TasksPanelContent {...props} />
      ) : (
        <TasksNotice
          icon={<UnplugIcon />}
          title="Tasks are unavailable"
          text={availability.reason}
        />
      )}
    </div>
  );
}

function TasksPanelContent(props: { threadKey: string; orbitProjectId: number | null }) {
  const { state, retry } = useOrbitTaskList(props.orbitProjectId);
  const navigation = useTasksNavigation(props.threadKey);
  const [liveStatus, setLiveStatus] = useState<OrbitTasksLiveStatus>("connecting");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the summary connection only while this Tasks surface is mounted
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void loadOrbitTasksClient().then((client) => {
      if (!disposed && client) stop = followTasksUpdates(client, setLiveStatus);
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  if (navigation.view === "task" && navigation.taskId !== null) {
    return (
      <TaskDetail
        key={`${props.threadKey}:${navigation.taskId}`}
        threadKey={props.threadKey}
        liveStatus={liveStatus}
        navigation={{ ...navigation, taskId: navigation.taskId }}
        listTitle={
          state.status === "ok"
            ? (state.value.tasks.find((task) => task.id === navigation.taskId)?.title ?? null)
            : null
        }
      />
    );
  }
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
function useRestoredScroll<T extends HTMLElement>(top: number, left: number) {
  const ref = useRef<T>(null);
  const [initial] = useState({ top, left });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the DOM scroll position saved before the tab unmounted
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = initial.top;
    ref.current.scrollLeft = initial.left;
  }, [initial]);
  return ref;
}

/** Search fills the row; Lanes sits in Conn's toolbar pill, like the terminal controls. */
function BoardToolbar() {
  const query = useTasksBoardQuery((state) => state.query);
  const hiddenLanes = useTasksBoardLanes((state) => state.hiddenLanes);
  const hidden = hiddenLanes.length;
  return (
    // Sits under the tab bar like the file view's breadcrumb row.
    <div className="flex shrink-0 items-center gap-2 px-3 pt-toolbar pb-3">
      <InputGroup variant="soft" className="h-8 min-w-0 flex-1">
        <InputGroupAddon>
          <SearchIcon aria-hidden className="size-4 opacity-50" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          size="sm"
          aria-label="Search tasks"
          placeholder="Search tasks"
          spellCheck={false}
          value={query}
          onChange={(event) => useTasksBoardQuery.getState().setQuery(event.currentTarget.value)}
        />
      </InputGroup>
      <ToolbarGroup className="shrink-0">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className="flex h-6.5 cursor-pointer items-center gap-1.5 rounded-(--control-radius) px-2 text-ui text-muted-foreground transition-colors hover:bg-(--shell-control) hover:text-foreground"
              />
            }
          >
            <SlidersHorizontalIcon aria-hidden className="size-4" />
            Lanes
            {hidden > 0 ? (
              <span className="text-muted-foreground/70 tabular-nums">
                · {ORBIT_TASK_LANES.length - hidden} of {ORBIT_TASK_LANES.length}
              </span>
            ) : null}
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Show lanes</MenuGroupLabel>
              {ORBIT_TASK_LANES.map((lane) => {
                const shown = !hiddenLanes.includes(lane.id);
                return (
                  <MenuCheckboxItem
                    key={lane.id}
                    checked={shown}
                    // One lane always stays on the board.
                    disabled={shown && hidden === ORBIT_TASK_LANES.length - 1}
                    onCheckedChange={() => useTasksBoardLanes.getState().toggleLane(lane.id)}
                    closeOnClick={false}
                  >
                    {lane.label}
                  </MenuCheckboxItem>
                );
              })}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </ToolbarGroup>
    </div>
  );
}

/** The visible lanes side by side, each a subtle container. Read-only: Orbit owns task state. */
function TasksBoard(props: {
  threadKey: string;
  tasks: ReadonlyArray<OrbitTaskSummary>;
  scroll: { readonly top: number; readonly left: number };
}) {
  const laneScroll = useTasksLaneScroll((state) => state.byThreadKey[props.threadKey]);
  const scrollRef = useRestoredScroll<HTMLDivElement>(props.scroll.top, props.scroll.left);
  const query = useTasksBoardQuery((state) => state.query);
  const hiddenLanes = useTasksBoardLanes((state) => state.hiddenLanes);
  const searching = query.trim().length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardToolbar />
      <div
        ref={scrollRef}
        onScrollEnd={(event) =>
          tasksPanelActions().saveBoardScroll(
            props.threadKey,
            event.currentTarget.scrollTop,
            event.currentTarget.scrollLeft,
          )
        }
        className="scrollbar-inset flex min-h-0 flex-1 gap-2 overflow-x-auto px-3 pb-3"
      >
        {tasksBoardLanes(props.tasks, { query, hiddenLanes }).map((lane) => (
          <section
            key={lane.id}
            aria-label={lane.label}
            className="flex min-w-48 flex-1 basis-0 flex-col rounded-xl bg-(--shell-highlight)/60 p-1.5 dark:bg-(--shell-highlight)/30"
          >
            <div className="flex h-8 shrink-0 items-center justify-between px-2 text-ui text-muted-foreground">
              <span className="font-medium">{lane.label}</span>
              <span className="tabular-nums">
                {searching ? `${lane.tasks.length} of ${lane.total}` : lane.tasks.length}
              </span>
            </div>
            <LaneList threadKey={props.threadKey} lane={lane.id} top={laneScroll?.[lane.id] ?? 0}>
              {lane.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onOpen={(laneTop) => {
                    // The lane unmounts at once, before a running scroll reports its end.
                    useTasksLaneScroll.getState().save(props.threadKey, lane.id, laneTop);
                    tasksPanelActions().openTask(props.threadKey, task.id);
                  }}
                />
              ))}
              {lane.tasks.length === 0 ? (
                <li className="px-3 py-4 text-center text-ui text-muted-foreground/70">
                  {searching && lane.total > 0 ? "No matches" : "Nothing here"}
                </li>
              ) : null}
            </LaneList>
          </section>
        ))}
      </div>
    </div>
  );
}

/** One lane's cards. It scrolls on its own and comes back where it was after a task. */
function LaneList(props: {
  threadKey: string;
  lane: OrbitTaskLane;
  top: number;
  children: ReactNode;
}) {
  const ref = useRestoredScroll<HTMLUListElement>(props.top, 0);
  return (
    <ul
      ref={ref}
      onScrollEnd={(event) =>
        useTasksLaneScroll
          .getState()
          .save(props.threadKey, props.lane, event.currentTarget.scrollTop)
      }
      className="scrollbar-inset m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto p-0"
    >
      {props.children}
    </ul>
  );
}

/** Stands in for a favicon: Orbit Projects have no Conn project icon here. */
function TaskProjectIcon(props: { project: OrbitTaskSummary["project"] }) {
  const hash = [...props.project.slug].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const color = PROJECT_ICON_COLORS[hash % PROJECT_ICON_COLORS.length]!.value;
  return <ProjectMonogram text={(props.project.name[0] ?? "?").toUpperCase()} color={color} />;
}

/**
 * The status at the card's top right. In progress shows only the working icon: the lane already
 * says it runs, and the list has no run time to show. Input and Blocked need the user.
 */
function TaskCardStatus(props: { task: OrbitTaskSummary }) {
  const { task } = props;
  const label = orbitTaskLabel(task);
  if (task.attention?.kind === "question") {
    return (
      <span className={cn("flex items-center gap-1 font-medium", INPUT_TONE)}>
        <MessageCircleQuestionIcon aria-hidden className="size-3.5" />
        Input
      </span>
    );
  }
  if (label?.tone === "destructive") {
    return (
      <span className="flex items-center gap-1 font-medium text-destructive-foreground">
        <CircleAlertIcon aria-hidden className="size-3.5" />
        {label.label}
      </span>
    );
  }
  if (label?.tone === "muted") {
    return <span className="text-muted-foreground">{label.label}</span>;
  }
  if (orbitTaskLane(task.status) === "in-progress") {
    return (
      <span className="flex items-center text-info-foreground">
        <CircleDashedIcon aria-hidden className="size-3.5" />
        <span className="sr-only">{label?.label ?? "In progress"}</span>
      </span>
    );
  }
  return (
    <span className="text-muted-foreground/80 tabular-nums">
      {formatRelativeTimeLabel(task.updatedAt)}
    </span>
  );
}

function TaskCard(props: { task: OrbitTaskSummary; onOpen: (laneTop: number) => void }) {
  const { task } = props;
  const pr = task.pullRequest;
  const prState = pr?.state ? resolvePullRequestState({ state: pr.state, isDraft: false }) : null;
  const working = orbitTaskLane(task.status) === "in-progress" && task.attention === null;
  return (
    <li>
      <button
        type="button"
        onClick={(event) => props.onOpen(event.currentTarget.closest("ul")?.scrollTop ?? 0)}
        className="flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border border-(--shell-divider)! bg-(--shell-card) px-3 py-2.5 text-left transition-colors hover:bg-(--shell-card)/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none dark:bg-(--shell-highlight)/70 dark:hover:bg-(--shell-highlight)"
      >
        <span className="flex items-center gap-1.5 text-ui leading-4">
          <TaskProjectIcon project={task.project} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground tabular-nums">
            #{task.id}
          </span>
          <span className="shrink-0">
            <TaskCardStatus task={task} />
          </span>
        </span>
        <span
          className={cn(
            "text-ui leading-5 text-foreground/90 [overflow-wrap:anywhere]",
            // Background work recedes to regular weight, like a working thread.
            working ? "font-normal" : "font-medium",
          )}
        >
          {task.title}
        </span>
        <span className="flex items-center gap-2 text-ui leading-4 text-muted-foreground tabular-nums">
          <span className="min-w-0 flex-1 truncate">{taskCardDetail(task)}</span>
          {pr ? (
            <span className={cn("flex shrink-0 items-center gap-1", prState?.toneClassName)}>
              {prState ? (
                <prState.Icon aria-hidden className="size-3.5" />
              ) : (
                <PullRequestGlyph.pullRequest className="size-3.5" />
              )}
              <span className="sr-only">Pull request{prState ? ` (${prState.label})` : ""}</span>#
              {pr.number}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
