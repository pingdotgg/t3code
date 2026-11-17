import {
  orbitTaskEnvironment,
  orbitTaskLabel,
  type OrbitSubtask,
  type OrbitTaskAgent,
  type OrbitTaskDetail,
  type OrbitTasksResult,
} from "@t3tools/client-runtime/orbit-gateway";
import {
  BotIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleIcon,
  FolderIcon,
  GaugeIcon,
  GitBranchIcon,
  ServerIcon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "~/components/chat/threadDetailsPanelStyles";
import {
  PullRequestDiffStat,
  resolvePullRequestState,
} from "~/components/pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { observeOrbitTask } from "./taskDetail.logic";
import { openOrbitAgentConversation } from "./orbitAgentConversation";
import { loadOrbitTasksClient } from "./orbitTasksClient";
import {
  agentStateText,
  agentStateTone,
  agentsFor,
  orbitAgentDriverKind,
  subtaskLead,
  subtaskStatusText,
  subtaskUsageText,
  TASK_STATUS_TEXT,
  taskLevelAgents,
  agentRowInteraction,
  taskUsage,
  type AgentRowModel,
  type StatusTone,
} from "./taskDetail.logic";
import { tasksErrorNotice } from "./tasksBoard.logic";
import { tasksPanelActions, type TasksDetailTab, type TasksNavigation } from "./tasksPanelStore";

type TaskState = { readonly status: "loading" } | OrbitTasksResult<OrbitTaskDetail>;

/**
 * One task's detail. Re-reads when the client invalidates this task or the list, keeping what it
 * shows until the answer; a transient read failure keeps the last good task on screen.
 */
function useOrbitTask(taskId: number) {
  const [state, setState] = useState<{ taskId: number; value: TaskState; attempt: number }>({
    taskId,
    attempt: 0,
    value: { status: "loading" },
  });
  const [attempt, setAttempt] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to authoritative Orbit reads and invalidations
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void loadOrbitTasksClient().then((client) => {
      if (disposed) return;
      if (client) {
        stop = observeOrbitTask(client, taskId, (value) => setState({ taskId, attempt, value }));
      } else {
        setState({
          taskId,
          attempt,
          value: { status: "error", reason: "unreachable", message: "No Orbit Gateway here." },
        });
      }
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [taskId, attempt]);
  return {
    state:
      state.taskId === taskId && state.attempt === attempt
        ? state.value
        : ({ status: "loading" } as const),
    retry: () => setAttempt((value) => value + 1),
  };
}

const ENVIRONMENT_TEXT = {
  disposed: "Workspace removed",
  stopped: "Workspace asleep",
  unreachable: "Conversations not reachable from here",
} as const;

const TONE_TEXT: Record<StatusTone, string> = {
  success: "text-success-foreground",
  info: "text-info-foreground",
  warning: "text-warning-foreground",
  destructive: "text-destructive-foreground",
  muted: "text-muted-foreground",
};

const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/45",
};

export function TaskDetail(props: {
  threadKey: string;
  navigation: TasksNavigation & { readonly taskId: number };
  /** The board's row, shown in the path while the detail loads. */
  listTitle: string | null;
}) {
  const { state, retry } = useOrbitTask(props.navigation.taskId);
  const title = state.status === "ok" ? state.value.title : props.listTitle;
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
        {title ? (
          <>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            <span className="min-w-0 truncate px-1 text-foreground">{title}</span>
          </>
        ) : null}
      </nav>
      {state.status === "loading" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner size="md" tone="muted" />
        </div>
      ) : state.status === "error" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <UnplugIcon aria-hidden className="size-5 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <span className="text-ui font-medium text-foreground">
              {tasksErrorNotice(state.reason).title}
            </span>
            <span className="text-ui text-muted-foreground">{state.message}</span>
          </div>
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : (
        <TaskDetailBody
          threadKey={props.threadKey}
          navigation={props.navigation}
          task={state.value}
        />
      )}
    </div>
  );
}

/**
 * Content on the left, contents sidebar on the right. Below the container breakpoint the sidebar
 * stacks above the content and the whole body scrolls as one.
 */
function TaskDetailBody(props: {
  threadKey: string;
  navigation: TasksNavigation;
  task: OrbitTaskDetail;
}) {
  const { task, navigation } = props;
  const outerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- puts the DOM scroller back where the store says when the shown brief or tab changes
  useLayoutEffect(() => {
    const top = navigation.detailScrollTop;
    for (const element of [outerRef.current, contentRef.current]) {
      if (element) element.scrollTop = top;
    }
  }, [navigation.detailScrollTop]);
  const saveScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      tasksPanelActions().saveDetailScroll(props.threadKey, event.currentTarget.scrollTop);
    }
  };
  const subtask =
    navigation.subtaskId === null
      ? null
      : (task.subtasks.find((entry) => entry.id === navigation.subtaskId) ?? null);
  return (
    <div className="@container/task flex min-h-0 flex-1">
      <div
        ref={outerRef}
        role="region"
        aria-label="Task detail"
        tabIndex={0}
        onScrollEnd={saveScroll}
        className="scrollbar-inset flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @3xl/task:flex-row @3xl/task:overflow-hidden"
      >
        <div
          ref={contentRef}
          onScrollEnd={saveScroll}
          className="scrollbar-inset order-2 min-w-0 flex-1 px-6 pt-6 pb-8 @3xl/task:order-1 @3xl/task:overflow-y-auto"
        >
          <TaskContent
            threadKey={props.threadKey}
            task={task}
            subtask={subtask}
            tab={navigation.tab}
          />
        </div>
        <TaskSidebar threadKey={props.threadKey} task={task} subtaskId={subtask?.id ?? null} />
      </div>
    </div>
  );
}

function TaskContent(props: {
  threadKey: string;
  task: OrbitTaskDetail;
  subtask: OrbitSubtask | null;
  tab: TasksDetailTab;
}) {
  const { task, subtask } = props;
  const agents = agentsFor(task, subtask?.id ?? null);
  const label = orbitTaskLabel(task);
  const environment = orbitTaskEnvironment(task);
  const meta = subtask
    ? [subtaskStatusText(subtask, task)]
    : [
        TASK_STATUS_TEXT[task.status],
        label && label.label !== "In review" && label.label !== "Working" ? label.label : null,
        environment.kind === "ready" || environment.kind === "not-started"
          ? null
          : ENVIRONMENT_TEXT[environment.kind],
      ].filter((part) => part !== null);
  const attention = subtask ? subtask.attention : task.attention;
  const attentionText =
    attention && attention.kind !== "observation" ? (attention.question ?? attention.reason) : null;
  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h2 className="m-0 text-lg leading-6 font-semibold text-foreground [overflow-wrap:anywhere]">
          {subtask ? subtask.title : task.title}
        </h2>
        <p className="m-0 text-ui text-muted-foreground">{meta.join(" · ")}</p>
      </header>
      {attentionText ? (
        <p
          className={cn(
            "m-0 rounded-lg px-3 py-2 text-ui",
            attention?.kind === "question" || attention?.kind === "direction"
              ? "bg-warning/10 text-warning-foreground"
              : "bg-destructive/10 text-destructive-foreground",
          )}
        >
          {attentionText}
        </p>
      ) : null}
      <div
        role="tablist"
        aria-label="Show"
        className="-mt-2 flex items-center gap-5 border-b border-(--shell-divider)!"
      >
        <ContentTab threadKey={props.threadKey} tab="brief" selected={props.tab === "brief"}>
          Brief
        </ContentTab>
        <ContentTab threadKey={props.threadKey} tab="agents" selected={props.tab === "agents"}>
          Agents
          <span className="font-normal text-muted-foreground tabular-nums">
            {agents.current.length}
          </span>
        </ContentTab>
      </div>
      {props.tab === "agents" ? (
        <AgentsList agents={agents} />
      ) : (
        <>
          {(subtask ? subtask.brief : task.brief).trim().length > 0 ? (
            <ChatMarkdown
              text={subtask ? subtask.brief : task.brief}
              cwd={undefined}
              headingLevelOffset={2}
            />
          ) : (
            <p className="m-0 text-ui text-muted-foreground">No brief.</p>
          )}
          {subtask && subtask.deliverables.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-sm font-medium text-muted-foreground">Deliverables</h3>
              <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-sm text-foreground/85">
                {subtask.deliverables.map((item) => (
                  <li key={item.id}>{item.description}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </article>
  );
}

function ContentTab(props: {
  threadKey: string;
  tab: TasksDetailTab;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.selected}
      onClick={() => tasksPanelActions().setTab(props.threadKey, props.tab)}
      className={cn(
        "-mb-px flex h-9 cursor-pointer items-center gap-1.5 border-b-2 px-0.5 text-ui font-medium transition-colors outline-none focus-visible:text-foreground",
        props.selected
          ? "border-foreground/80 text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground/85",
      )}
    >
      {props.children}
    </button>
  );
}

function AgentsList(props: { agents: ReturnType<typeof agentsFor> }) {
  const { current, earlier } = props.agents;
  return (
    <div className="flex flex-col gap-6">
      {current.length > 0 ? (
        <ul className="-mx-2.5 m-0 list-none p-0">
          {current.map((row) => (
            <AgentRow key={row.agent.id} row={row} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-ui text-muted-foreground">No agent has started.</p>
      )}
      {earlier.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-medium text-muted-foreground">Earlier attempts</h3>
          <ul className="-mx-2.5 m-0 list-none p-0">
            {earlier.map((row) => (
              <AgentRow key={row.agent.id} row={row} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AgentIcon(props: { agent: OrbitTaskAgent; tone: StatusTone }) {
  const driverKind = orbitAgentDriverKind(props.agent.provider);
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {driverKind ? (
        <ProviderInstanceIcon
          driverKind={driverKind}
          displayName={props.agent.provider ?? "Agent"}
          size="compact"
        />
      ) : (
        <BotIcon aria-hidden className="size-3.5 text-muted-foreground" />
      )}
      <span
        aria-hidden
        className={cn(
          "absolute -right-1 -bottom-1 z-40 size-2 rounded-full border-2 border-(--shell-card)",
          TONE_DOT[props.tone],
        )}
      />
    </span>
  );
}

/** One agent. Only an agent with a Conn conversation is a control; the rest are plain rows. */
function AgentRow(props: { row: AgentRowModel }) {
  const { agent, conversation, label } = props.row;
  const interaction = agentRowInteraction(props.row);
  const tone = agentStateTone(agent);
  const content = (
    <>
      <AgentIcon agent={agent} tone={tone} />
      <span className="min-w-0 flex-1 truncate text-left">
        {label}
        {agent.model ? (
          <span className="font-normal text-muted-foreground"> · {agent.model}</span>
        ) : null}
      </span>
      <span className={cn("shrink-0 font-normal", TONE_TEXT[tone])}>{agentStateText(agent)}</span>
    </>
  );
  return (
    <li className="flex min-h-8 items-center border-b border-(--shell-divider)! last:border-b-0">
      {interaction === "button" && conversation ? (
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          onClick={() => openOrbitAgentConversation(conversation)}
        >
          {content}
        </ThreadDetailsControl>
      ) : (
        <div
          className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}
          aria-label={`${label}. Conversation unavailable`}
        >
          {content}
        </div>
      )}
    </li>
  );
}

function TaskSidebar(props: {
  threadKey: string;
  task: OrbitTaskDetail;
  subtaskId: number | null;
}) {
  const { task } = props;
  const taskAgents = taskLevelAgents(task);
  return (
    <nav
      aria-label="Task contents"
      className="order-1 flex shrink-0 flex-col border-b border-(--shell-divider)! px-2 pb-3 @3xl/task:order-2 @3xl/task:w-88 @3xl/task:overflow-y-auto @3xl/task:border-s @3xl/task:border-b-0 scrollbar-inset"
    >
      {/* "Task #id" opens the task's own brief, level with the content title. */}
      <div className="mt-5 shrink-0">
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          aria-current={props.subtaskId === null ? "page" : undefined}
          onClick={() => tasksPanelActions().openSubtask(props.threadKey, null, "brief")}
        >
          <span className="text-foreground/90">Task</span>
          <span className="-ms-1 font-normal text-muted-foreground tabular-nums">#{task.id}</span>
        </ThreadDetailsControl>
      </div>
      <TaskWorkspaceRows task={task} />
      <div className="mt-3 flex h-8 shrink-0 items-center px-2.5 text-ui font-medium text-muted-foreground">
        Subtasks
      </div>
      {task.subtasks.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {task.subtasks.map((subtask) => (
            <SubtaskRow
              key={subtask.id}
              threadKey={props.threadKey}
              task={task}
              subtask={subtask}
              selected={subtask.id === props.subtaskId}
            />
          ))}
        </ul>
      ) : (
        <p className="m-0 px-2.5 text-ui text-muted-foreground">No subtasks yet.</p>
      )}
      {taskAgents.length > 0 ? (
        <>
          <div className="mt-3 flex h-8 shrink-0 items-center px-2.5 text-ui font-medium text-muted-foreground">
            Agents
          </div>
          <ul className="m-0 list-none p-0">
            {taskAgents.map((row) => (
              <AgentRow key={row.agent.id} row={row} />
            ))}
          </ul>
        </>
      ) : null}
    </nav>
  );
}

const ROW = cn(
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  "flex items-center font-normal text-muted-foreground",
);

const MACHINE_STATE = {
  "not-started": "No workspace yet",
  disposed: "Removed",
  stopped: "Asleep",
  unreachable: "Not reachable",
} as const;

/** Where the task runs and what it led to. */
function TaskWorkspaceRows(props: { task: OrbitTaskDetail }) {
  const { task } = props;
  const environment = orbitTaskEnvironment(task);
  const usage = taskUsage(task.metrics);
  const machine = task.workspace?.node?.name ?? task.workspace?.name ?? null;
  return (
    <div className="mt-3 flex flex-col">
      <div className={ROW}>
        <FolderIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 flex-1 truncate text-foreground/85">{task.project.name}</span>
      </div>
      <div className={ROW}>
        <ServerIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 flex-1 truncate">{machine ?? "No machine"}</span>
        {environment.kind === "ready" ? null : (
          <span
            className={cn(
              "shrink-0",
              environment.kind === "disposed" || environment.kind === "unreachable"
                ? "text-destructive-foreground"
                : undefined,
            )}
          >
            {MACHINE_STATE[environment.kind]}
          </span>
        )}
      </div>
      {task.workspace?.branch ? (
        <div className={ROW}>
          <GitBranchIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">{task.workspace.branch}</span>
        </div>
      ) : null}
      {task.pullRequest ? <PullRequestRow pr={task.pullRequest} /> : null}
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={<div tabIndex={0} className={cn(ROW, "h-auto min-h-8 flex-wrap py-1.5")} />}
        >
          <GaugeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 tabular-nums">{usage.text}</span>
          {usage.lines ? (
            <span className="flex shrink-0 items-baseline gap-1">
              Branch diff
              <span className="text-success-foreground">+{usage.lines.added.toLocaleString()}</span>
              <span className="text-destructive-foreground">
                −{usage.lines.deleted.toLocaleString()}
              </span>
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left" className="max-w-72">
          {usage.description}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The task's pull request. Opening it in the PR tab comes with the PR round trip. */
function PullRequestRow(props: { pr: NonNullable<OrbitTaskDetail["pullRequest"]> }) {
  const { pr } = props;
  const state = pr.state ? resolvePullRequestState({ state: pr.state, isDraft: false }) : null;
  const Icon = state?.Icon;
  return (
    <div className={ROW}>
      {Icon ? (
        <Icon aria-hidden className={cn("size-4 shrink-0", state?.toneClassName)} />
      ) : (
        <PullRequestGlyph.pullRequest className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-foreground/85">Pull request</span>
      <span className="shrink-0 tabular-nums">
        #{pr.number} · {state?.label ?? "State unknown"}
      </span>
    </div>
  );
}

function SubtaskLeadIcon(props: { lead: ReturnType<typeof subtaskLead> }) {
  const { lead } = props;
  const className = "size-4 shrink-0";
  switch (lead.kind) {
    case "agent":
      return <AgentIcon agent={lead.agent} tone={lead.tone} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
    case "not-started":
      return <CircleIcon aria-hidden className={cn(className, "text-muted-foreground/45")} />;
    case "state": {
      const Icon =
        lead.tone === "success"
          ? CircleCheckIcon
          : lead.tone === "warning"
            ? CircleHelpIcon
            : lead.tone === "destructive"
              ? CircleAlertIcon
              : lead.tone === "info"
                ? CircleDotIcon
                : CircleIcon;
      return <Icon aria-hidden className={cn(className, TONE_TEXT[lead.tone])} />;
    }
  }
}

/**
 * A subtask: the row opens its brief; an agent icon in front opens its Agents tab. Lines show only
 * when Orbit reports them (never today), and the quiet line only what is known.
 */
function SubtaskRow(props: {
  threadKey: string;
  task: OrbitTaskDetail;
  subtask: OrbitSubtask;
  selected: boolean;
}) {
  const { subtask } = props;
  const lead = subtaskLead(props.task, subtask);
  const usage = subtaskUsageText(subtask.metrics);
  const { linesAdded, linesDeleted } = subtask.metrics;
  const status = subtaskStatusText(subtask, props.task);
  return (
    <li
      className={cn(
        "flex items-start rounded-lg hover:bg-(--shell-highlight)",
        props.selected && "bg-(--shell-highlight)",
      )}
    >
      {lead.kind === "agent" ? (
        <button
          type="button"
          aria-label={`${status}. Agents for ${subtask.title}`}
          onClick={() => tasksPanelActions().openSubtask(props.threadKey, subtask.id, "agents")}
          className="ms-1.5 mt-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-(--shell-highlight) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
        >
          <SubtaskLeadIcon lead={lead} />
        </button>
      ) : (
        <span
          className="ms-1.5 mt-1.5 flex size-5 shrink-0 items-center justify-center"
          aria-label={status}
        >
          <SubtaskLeadIcon lead={lead} />
        </span>
      )}
      <button
        type="button"
        aria-current={props.selected ? "page" : undefined}
        aria-label={`${subtask.title}. ${status}. Open brief`}
        onClick={() => tasksPanelActions().openSubtask(props.threadKey, subtask.id, "brief")}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 rounded-lg py-1.5 ps-2 pe-2.5 text-left text-ui focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-start gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]",
              lead.kind === "not-started" ? "text-muted-foreground" : "text-foreground/85",
            )}
          >
            {subtask.title}
          </span>
          {linesAdded !== null && linesDeleted !== null ? (
            <PullRequestDiffStat
              additions={linesAdded}
              deletions={linesDeleted}
              className="shrink-0 leading-5"
            />
          ) : null}
        </span>
        {usage ? (
          <span className="leading-4 text-muted-foreground tabular-nums">{usage}</span>
        ) : null}
      </button>
    </li>
  );
}
