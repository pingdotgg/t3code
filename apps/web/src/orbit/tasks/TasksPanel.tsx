import {
  ORBIT_TASK_LANES,
  type OrbitTaskLane,
  type OrbitTasksPage,
  type OrbitTasksResult,
  type OrbitTaskSummary,
  type OrbitTasksLiveStatus,
} from "@t3tools/client-runtime/orbit-gateway";
import {
  ListTodoIcon,
  LockIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UnplugIcon,
} from "lucide-react";
import { useGT, useMessages } from "gt-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ToolbarGroup } from "~/components/ToolbarGroup";
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
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { useStableCallback } from "~/hooks/useStableCallback";

import { useOrbitTaskNavigation } from "./orbitAgentConversation";
import { TaskDetail, type TasksPanelHost } from "./TaskDetail";
import { TasksInsightsStrip } from "./TasksInsights";
import { INSIGHT_PERIODS, INSIGHTS } from "@t3tools/client-runtime/orbit-gateway";
import { TaskCardButton, TaskCardPullRequestBadge } from "./TaskCardButton";
import {
  followTasksUpdates,
  loadOrbitTasksClient,
  orbitTasksAvailability,
} from "./orbitTasksClient";
import { tasksBoardLanes, tasksErrorNotice } from "./tasksBoard.logic";
import {
  tasksPanelActions,
  useTasksBoardQuery,
  useTasksLaneScroll,
  useTasksNavigation,
  useTasksBoardSettings,
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
type TasksPanelProps = {
  threadKey: string;
  orbitProjectId: number | null;
  host: TasksPanelHost;
};

export function TasksPanel(props: TasksPanelProps) {
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

function TasksPanelContent(props: TasksPanelProps) {
  const { state, retry } = useOrbitTaskList(props.orbitProjectId);
  const navigation = useTasksNavigation(props.threadKey);
  // One instance for the board and the task, so an error from a card's PR badge shows on the task.
  const orbitNavigation = useOrbitTaskNavigation(
    props.threadKey,
    navigation.view === "task" && navigation.taskId !== null
      ? { taskId: navigation.taskId, subtaskId: navigation.subtaskId }
      : null,
  );
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
        orbitNavigation={orbitNavigation}
        host={props.host}
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
  return (
    <TasksBoard
      threadKey={props.threadKey}
      orbitProjectId={props.orbitProjectId}
      tasks={tasks}
      scroll={navigation.boardScroll}
      onOpenPullRequest={(task, url) => {
        // Without a project for its repository the task opens, and the task shows the error.
        if (!orbitNavigation.openPullRequest(task.id, url)) {
          tasksPanelActions().openTask(props.threadKey, task.id);
        }
      }}
    />
  );
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

/** Search fills the row; board settings sit in Conn's toolbar pill, like the terminal controls. */
function BoardToolbar() {
  const gt = useGT();
  const messages = useMessages();
  const query = useTasksBoardQuery((state) => state.query);
  const settings = useTasksBoardSettings();
  const hidden = settings.hiddenLanes.length;
  return (
    // Sits under the tab bar like the file view's breadcrumb row.
    <div className="flex shrink-0 items-center gap-2 px-2 py-toolbar">
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
                aria-label={gt("Board settings")}
                className="flex size-6.5 cursor-pointer items-center justify-center rounded-(--control-radius) text-muted-foreground transition-colors hover:bg-(--shell-control) hover:text-foreground data-popup-open:bg-(--shell-control) data-popup-open:text-foreground"
              />
            }
          >
            <SlidersHorizontalIcon aria-hidden className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-52">
            <MenuGroup>
              <MenuGroupLabel>{gt("Lanes")}</MenuGroupLabel>
              {ORBIT_TASK_LANES.map((lane) => {
                const shown = !settings.hiddenLanes.includes(lane.id);
                return (
                  <MenuCheckboxItem
                    key={lane.id}
                    checked={shown}
                    // One lane always stays on the board.
                    disabled={shown && hidden === ORBIT_TASK_LANES.length - 1}
                    onCheckedChange={() => settings.toggleLane(lane.id)}
                    closeOnClick={false}
                  >
                    {lane.label}
                  </MenuCheckboxItem>
                );
              })}
            </MenuGroup>
            {/* -mx-1: the popup's p-1 inset; the line runs to the menu's edge. */}
            <MenuSeparator className="-mx-1" />
            <MenuGroup>
              <MenuGroupLabel>{gt("Insights")}</MenuGroupLabel>
              {INSIGHTS.map((insight) => (
                <MenuCheckboxItem
                  key={insight.id}
                  checked={!settings.hiddenInsights.includes(insight.id)}
                  onCheckedChange={() => settings.toggleInsight(insight.id)}
                  closeOnClick={false}
                >
                  {messages(insight.label)}
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
            <MenuSeparator className="-mx-1" />
            <MenuGroup>
              <MenuGroupLabel>{gt("Insights period")}</MenuGroupLabel>
              {/* One choice, with the same check as the items above so the groups line up. */}
              {INSIGHT_PERIODS.map((period) => (
                <MenuCheckboxItem
                  key={period}
                  role="menuitemradio"
                  checked={settings.insightPeriod === period}
                  onCheckedChange={() => settings.setInsightPeriod(period)}
                  closeOnClick={false}
                >
                  {period === "24h"
                    ? gt("Last 24 hours")
                    : period === "7d"
                      ? gt("Last 7 days")
                      : gt("Last 30 days")}
                </MenuCheckboxItem>
              ))}
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
  orbitProjectId: number | null;
  tasks: ReadonlyArray<OrbitTaskSummary>;
  scroll: { readonly top: number; readonly left: number };
  onOpenPullRequest: (task: OrbitTaskSummary, url: string) => void;
}) {
  const laneScroll = useTasksLaneScroll((state) => state.byThreadKey[props.threadKey]);
  // The board scrolls down past the insights; the lanes scroll sideways.
  const boardRef = useRestoredScroll<HTMLDivElement>(props.scroll.top, 0);
  const lanesRef = useRestoredScroll<HTMLDivElement>(0, props.scroll.left);
  const saveScroll = () =>
    tasksPanelActions().saveBoardScroll(
      props.threadKey,
      boardRef.current?.scrollTop ?? 0,
      lanesRef.current?.scrollLeft ?? 0,
    );
  const query = useTasksBoardQuery((state) => state.query);
  const hiddenLanes = useTasksBoardSettings((state) => state.hiddenLanes);
  const searching = query.trim().length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardToolbar />
      {/* A short panel scrolls the insights away, so the lanes keep room for their cards. */}
      <div
        ref={boardRef}
        onScrollEnd={(event) => {
          if (event.target === event.currentTarget) saveScroll();
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <TasksInsightsStrip orbitProjectId={props.orbitProjectId} query={query} />
        <div
          ref={lanesRef}
          onScrollEnd={(event) => {
            if (event.target === event.currentTarget) saveScroll();
          }}
          // The board pads its lanes by the gap between them (8px).
          className="scrollbar-inset flex min-h-64 flex-1 gap-2 overflow-x-auto p-2"
        >
          {tasksBoardLanes(props.tasks, { query, hiddenLanes }).map((lane) => (
            <section
              key={lane.id}
              aria-label={lane.label}
              className="flex min-w-48 flex-1 basis-0 flex-col rounded-xl bg-(--shell-highlight)/60 p-1.5 pt-0 dark:bg-(--shell-highlight)/30"
            >
              {/* 8px from the lane top and 8px above the first card. */}
              <div className="flex shrink-0 items-center justify-between px-2 py-2 text-ui text-muted-foreground">
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
                    onOpen={(laneTop, pullRequestUrl) => {
                      // The lane unmounts at once, before a running scroll reports its end.
                      useTasksLaneScroll.getState().save(props.threadKey, lane.id, laneTop);
                      saveScroll();
                      if (pullRequestUrl) props.onOpenPullRequest(task, pullRequestUrl);
                      else tasksPanelActions().openTask(props.threadKey, task.id);
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
      // Lanes scroll without a visible scrollbar.
      className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {props.children}
    </ul>
  );
}

function TaskCard(props: {
  task: OrbitTaskSummary;
  /** With a URL the card's PR badge was clicked: the PR opens below the task. */
  onOpen: (laneTop: number, pullRequestUrl?: string) => void;
}) {
  const { task } = props;
  const laneTop = (element: HTMLElement) => element.closest("ul")?.scrollTop ?? 0;
  return (
    <li className="relative">
      <TaskCardButton task={task} onClick={(event) => props.onOpen(laneTop(event.currentTarget))} />
      <TaskCardPullRequestBadge
        task={task}
        onOpen={(event, url) => props.onOpen(laneTop(event.currentTarget), url)}
      />
    </li>
  );
}
