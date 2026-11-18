import {
  orbitTaskEnvironment,
  type OrbitSubtask,
  type OrbitTaskAgent,
  type OrbitTaskDetail,
  type OrbitTasksResult,
  type OrbitTasksLiveStatus,
} from "@t3tools/client-runtime/orbit-gateway";
import {
  BotIcon,
  CheckIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleIcon,
  GaugeIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  ServerIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

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
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { observeOrbitTask } from "./taskDetail.logic";
import { useOrbitTaskNavigation } from "./orbitAgentConversation";
import { loadOrbitTasksClient } from "./orbitTasksClient";
import {
  agentStateText,
  agentStateTone,
  agentsFor,
  orbitAgentDriverKind,
  subtaskLead,
  subtaskStatusText,
  subtaskUsageText,
  taskLevelAgents,
  agentRowInteraction,
  taskUsage,
  type AgentRowModel,
  type StatusTone,
  INPUT_TONE,
} from "./taskDetail.logic";
import { tasksErrorNotice } from "./tasksBoard.logic";
import { tasksPanelActions, type TasksDetailTab, type TasksNavigation } from "./tasksPanelStore";

const NavigationContext = createContext<ReturnType<typeof useOrbitTaskNavigation> | null>(null);

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

const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/45",
};

export function TaskDetail(props: {
  threadKey: string;
  liveStatus: OrbitTasksLiveStatus;
  navigation: TasksNavigation & { readonly taskId: number };
  /** The board's row, shown in the path while the detail loads. */
  listTitle: string | null;
}) {
  const navigation = useOrbitTaskNavigation(props.threadKey);
  const { state, retry } = useOrbitTask(props.navigation.taskId);
  const title = state.status === "ok" ? state.value.title : props.listTitle;
  const subtaskTitle =
    state.status === "ok" && props.navigation.subtaskId !== null
      ? (state.value.subtasks.find((entry) => entry.id === props.navigation.subtaskId)?.title ??
        null)
      : null;
  return (
    <NavigationContext value={navigation}>
      <div className="flex min-h-0 flex-1 flex-col">
        <nav
          aria-label="Tasks path"
          className="flex h-9 shrink-0 items-center gap-2 border-b border-(--shell-divider)! px-4.5 text-ui"
        >
          {props.navigation.originThreadKey ? (
            <>
              <button
                type="button"
                onClick={navigation.returnToOrigin}
                className="shrink-0 cursor-pointer rounded-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Origin thread
              </button>
              <span aria-hidden className="text-muted-foreground/60">
                ·
              </span>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => tasksPanelActions().showBoard(props.threadKey)}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeftIcon aria-hidden className="size-4 shrink-0" />
            Tasks
          </button>
          {title ? (
            <>
              <span aria-hidden className="text-muted-foreground/60">
                /
              </span>
              {subtaskTitle ? (
                <>
                  {/* In a subtask the task is a step back, on the task's own tab. */}
                  <button
                    type="button"
                    onClick={() => tasksPanelActions().openSubtask(props.threadKey, null)}
                    className="max-w-[45%] min-w-0 shrink cursor-pointer truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {title}
                  </button>
                  <span aria-hidden className="text-muted-foreground/60">
                    /
                  </span>
                  <span className="min-w-0 truncate text-foreground/85">{subtaskTitle}</span>
                </>
              ) : (
                <span className="min-w-0 truncate text-foreground/85">{title}</span>
              )}
            </>
          ) : null}
          <span className="ml-auto shrink-0 text-muted-foreground/70">
            {props.liveStatus === "live"
              ? "Live"
              : props.liveStatus === "polling"
                ? "Updates every 30s"
                : "Connecting updates"}
          </span>
        </nav>
        {navigation.error ? (
          <p
            role="alert"
            className="m-1 rounded-lg bg-warning/10 p-2 text-ui text-warning-foreground"
          >
            {navigation.error}
          </p>
        ) : null}
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
    </NavigationContext>
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
  const actions = use(NavigationContext);
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
  const saveCurrentScroll = () =>
    tasksPanelActions().saveDetailScroll(
      props.threadKey,
      Math.max(outerRef.current?.scrollTop ?? 0, contentRef.current?.scrollTop ?? 0),
    );
  const openAgent = async (ref: Parameters<NonNullable<typeof actions>["openAgent"]>[0]) => {
    saveCurrentScroll();
    await actions?.openAgent(ref);
  };
  const openPullRequest = (url: string) => {
    saveCurrentScroll();
    actions?.openPullRequest(url);
  };
  return (
    <NavigationContext value={actions ? { ...actions, openAgent, openPullRequest } : null}>
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
    </NavigationContext>
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
  const attention = subtask ? subtask.attention : task.attention;
  const attentionText =
    attention && attention.kind !== "observation" ? (attention.question ?? attention.reason) : null;
  const brief = subtask ? subtask.brief : task.brief;
  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h2 className="m-0 text-lg leading-6 font-medium text-foreground [overflow-wrap:anywhere]">
          {subtask ? subtask.title : task.title}
        </h2>
      </header>
      <div
        role="tablist"
        aria-label="Show"
        className="-mt-2 flex items-center gap-5 border-b border-(--shell-divider)!"
      >
        <ContentTab threadKey={props.threadKey} tab="brief" selected={props.tab === "brief"}>
          Overview
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
          {subtask ? <SubtaskSummaryRows task={task} subtask={subtask} /> : null}
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
          <h2 className="m-0 -mb-2 text-base leading-6 font-medium text-foreground">Brief</h2>
          {brief.trim().length > 0 ? (
            // Headings inside a brief stay below the Brief heading: body size, medium weight.
            <div className="[&_:is(h1,h2,h3,h4,h5,h6)]:text-sm! [&_:is(h1,h2,h3,h4,h5,h6)]:font-medium!">
              <ChatMarkdown text={brief} cwd={undefined} headingLevelOffset={2} />
            </div>
          ) : (
            <p className="m-0 text-ui text-muted-foreground">No brief.</p>
          )}
          {subtask && subtask.deliverables.length > 0 ? (
            <section className="flex flex-col gap-4">
              <h2 className="m-0 text-base leading-6 font-medium text-foreground">Deliverables</h2>
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

/** A subtask's Overview opens with its status and usage, the rows the task keeps in its sidebar. */
function SubtaskSummaryRows(props: { task: OrbitTaskDetail; subtask: OrbitSubtask }) {
  const { task, subtask } = props;
  const lead = subtaskLead(task, subtask);
  return (
    <div className="-mx-2.5 -my-1 flex flex-col">
      <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center font-normal")}>
        <SubtaskLeadIcon lead={lead} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
          {subtaskStatusText(subtask, task)}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {subtask.position} of {task.subtasks.length}
        </span>
      </div>
      <div className={ROW}>
        <GaugeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 flex-1 truncate">
          <SubtaskMeta metrics={subtask.metrics} />
        </span>
        <SubtaskDiff metrics={subtask.metrics} />
      </div>
    </div>
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

/** Same run states as thread rows: the working icon, Input, Failed, else the state in words. */
function AgentState(props: { agent: OrbitTaskAgent }) {
  const { agent } = props;
  if (agent.needsInput || agent.state === "asking_for_input") {
    return (
      <span className={cn("flex shrink-0 items-center gap-1 text-ui font-medium", INPUT_TONE)}>
        <MessageCircleQuestionIcon aria-hidden className="size-3.5" />
        Input
      </span>
    );
  }
  if (agent.state === "working") {
    return (
      <span className="flex shrink-0 items-center text-info-foreground">
        <CircleDashedIcon aria-hidden className="size-3.5" />
        <span className="sr-only">{agentStateText(agent)}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "shrink-0 text-ui font-normal tabular-nums",
        agent.state === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {agentStateText(agent)}
    </span>
  );
}

/**
 * One agent on two lines: the role, then what it works on and its model. Only an agent with a
 * Conn conversation is a control; the rest are plain rows.
 */
function AgentRow(props: { row: AgentRowModel; detail?: string }) {
  const navigation = use(NavigationContext);
  const { agent, conversation, label } = props.row;
  const interaction = agentRowInteraction(props.row);
  const tone = agentStateTone(agent);
  const [role, ...rest] = label.split(" · ");
  const detail =
    props.detail ??
    [rest.join(" · ") || null, agent.model].filter((part) => part !== null).join(" · ");
  const content = (
    <>
      <AgentIcon agent={agent} tone={tone} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-ui font-medium text-foreground/85">{role}</span>
        {detail ? (
          <span className="truncate text-ui leading-4 font-normal text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
      <AgentState agent={agent} />
    </>
  );
  return (
    <li className="relative flex min-h-8 items-center">
      {interaction === "button" && conversation ? (
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          multiline
          className="items-start [&>*:first-child]:mt-0.5"
          onClick={() => void navigation?.openAgent(conversation)}
        >
          {content}
        </ThreadDetailsControl>
      ) : (
        <div
          className={cn(
            THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
            "flex h-auto min-h-8 items-start py-1.5 sm:h-auto [&>*:first-child]:mt-0.5",
          )}
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
  const done = task.subtasks.filter((subtask) => subtask.status === "completed").length;
  return (
    <nav
      aria-label="Task contents"
      className="order-1 flex shrink-0 flex-col border-b border-(--shell-divider)! @3xl/task:order-2 @3xl/task:w-88 @3xl/task:overflow-y-auto @3xl/task:border-s @3xl/task:border-b-0 scrollbar-inset"
    >
      {/* No "Task #id" row: the path leads back to the task. Rows start level with the title. */}
      <div className="mt-4.75 shrink-0 px-2">
        <TaskWorkspaceRows task={task} />
      </div>
      {/* Full-width dividers; every section keeps the same space above and below its text. */}
      <div aria-hidden className="mt-4.75 h-px shrink-0 bg-(--shell-divider)" />
      <div className="mt-4.5 flex h-8 shrink-0 items-center justify-between px-4.5 text-ui text-muted-foreground">
        <span className="font-medium">Subtasks</span>
        {task.subtasks.length > 0 ? (
          <span className="tabular-nums">
            {done}/{task.subtasks.length}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col px-2 pb-3">
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
            <div aria-hidden className="-mx-2 mt-4.5 h-px shrink-0 bg-(--shell-divider)" />
            <div className="mt-4.5 flex h-8 shrink-0 items-center px-2.5 text-ui font-medium text-muted-foreground">
              Agents
            </div>
            <ul className="m-0 list-none p-0">
              {taskAgents.map((row) => (
                <AgentRow
                  key={row.agent.id}
                  row={row}
                  detail={[
                    row.label.endsWith("all subtasks") ? "All subtasks" : "Whole task",
                    row.agent.model,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </nav>
  );
}

const ROW = cn(
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  "flex items-center font-normal text-muted-foreground",
);

const MACHINE_STATE = {
  "not-started": "No workspace yet",
  disposed: "removed",
  stopped: "asleep",
  unreachable: "offline",
} as const;

/** Where the task runs and what it led to: the same rows as the Thread details card. */
function TaskWorkspaceRows(props: { task: OrbitTaskDetail }) {
  const { task } = props;
  const environment = orbitTaskEnvironment(task);
  const usage = taskUsage(task.metrics);
  const machine = task.workspace?.node?.name ?? task.workspace?.name ?? null;
  const machineText =
    environment.kind === "ready"
      ? machine
      : environment.kind === "not-started"
        ? MACHINE_STATE["not-started"]
        : [machine, MACHINE_STATE[environment.kind]].filter((part) => part !== null).join(" · ");
  return (
    <div className="flex flex-col">
      <div className={ROW}>
        <ServerIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 flex-1 truncate">{task.project.name}</span>
        {machineText ? (
          <span
            className={cn(
              "shrink-0",
              environment.kind === "disposed" || environment.kind === "unreachable"
                ? "text-destructive-foreground"
                : undefined,
            )}
          >
            {machineText}
          </span>
        ) : null}
      </div>
      {task.workspace?.branch ? (
        <div className={ROW}>
          <GitBranchIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">{task.workspace.branch}</span>
        </div>
      ) : null}
      {task.pullRequest ? <PullRequestRow pr={task.pullRequest} /> : null}
      <Tooltip>
        <TooltipTrigger delay={200} render={<div tabIndex={0} className={ROW} />}>
          <GaugeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate tabular-nums">{usage.text}</span>
          {usage.lines ? (
            <PullRequestDiffStat
              additions={usage.lines.added}
              deletions={usage.lines.deleted}
              className="shrink-0"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left" className="max-w-72">
          {usage.description}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The task's pull request. It opens in Conn's pull request panel as a tab. */
function PullRequestRow(props: { pr: NonNullable<OrbitTaskDetail["pullRequest"]> }) {
  const navigation = use(NavigationContext);
  const { pr } = props;
  const state = pr.state ? resolvePullRequestState({ state: pr.state, isDraft: false }) : null;
  const Icon = state?.Icon;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <ThreadDetailsControl
            size="sm"
            part="row"
            variant="ghost"
            onClick={() => navigation?.openPullRequest(pr.url)}
            aria-label={`Pull request #${pr.number}. ${state?.label ?? "State unknown"}. Open in the pull request panel`}
          />
        }
      >
        {Icon ? (
          <Icon aria-hidden className={cn("size-4 shrink-0", state?.toneClassName)} />
        ) : (
          <PullRequestGlyph.pullRequest className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-left font-normal text-foreground/85">
          Pull request
        </span>
        <span className="shrink-0 font-normal text-muted-foreground tabular-nums">
          #{pr.number}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" className="max-w-72">
        {state?.label ?? "State unknown"}. Opens in the pull request panel.
      </TooltipPopup>
    </Tooltip>
  );
}

function SubtaskLeadIcon(props: { lead: ReturnType<typeof subtaskLead> }) {
  const { lead } = props;
  const className = "size-4 shrink-0";
  switch (lead.kind) {
    case "agent":
      return <AgentIcon agent={lead.agent} tone={lead.tone} />;
    case "done":
      return <CheckIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
    case "not-started":
      return (
        <CircleIcon aria-hidden className={cn(className, "text-muted-foreground opacity-40")} />
      );
    case "state":
      switch (lead.tone) {
        case "success":
          return <CheckIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
        case "info":
          return <CircleDashedIcon aria-hidden className={cn(className, "text-info-foreground")} />;
        case "warning":
          return (
            <CircleAlertIcon aria-hidden className={cn(className, "text-warning-foreground")} />
          );
        case "destructive":
          return <XIcon aria-hidden className={cn(className, "text-destructive-foreground")} />;
        case "muted":
          return <CircleIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
      }
  }
}

/** Unreported values show a dash, never zero. */
const UNKNOWN = <span className="opacity-50">–</span>;

/** Lines on the title line, right-aligned like the task's usage row. */
function SubtaskDiff(props: { metrics: OrbitSubtask["metrics"] }) {
  const { linesAdded, linesDeleted } = props.metrics;
  return (
    <span
      aria-hidden
      className="shrink-0 text-ui leading-5 font-normal text-muted-foreground tabular-nums"
    >
      {linesAdded === null || linesDeleted === null ? (
        UNKNOWN
      ) : linesAdded === 0 && linesDeleted === 0 ? (
        "No changes"
      ) : (
        <PullRequestDiffStat additions={linesAdded} deletions={linesDeleted} />
      )}
    </span>
  );
}

/** Time and tokens under the title. */
function SubtaskMeta(props: { metrics: OrbitSubtask["metrics"] }) {
  const { durationMs, tokens } = props.metrics;
  return (
    <span
      aria-hidden
      className="text-ui leading-4 font-normal whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {durationMs === null ? UNKNOWN : formatWorkingDurationLabel(durationMs)} ·{" "}
      {tokens === null ? UNKNOWN : `${formatTokens(tokens)} tokens`}
    </span>
  );
}

/**
 * A subtask: the row opens its Overview; an agent icon in front opens its Agents tab. Lines and
 * the quiet line show a dash for what Orbit does not report.
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
          className="ms-2 mt-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-(--shell-highlight) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
        >
          <SubtaskLeadIcon lead={lead} />
        </button>
      ) : (
        <span
          className="ms-2 mt-1.5 flex size-5 shrink-0 items-center justify-center"
          aria-label={status}
        >
          <SubtaskLeadIcon lead={lead} />
        </span>
      )}
      <button
        type="button"
        aria-current={props.selected ? "page" : undefined}
        aria-label={`${subtask.title}. ${status}.${usage ? ` ${usage}.` : ""} Open subtask`}
        onClick={() => tasksPanelActions().openSubtask(props.threadKey, subtask.id)}
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
          <SubtaskDiff metrics={subtask.metrics} />
        </span>
        <SubtaskMeta metrics={subtask.metrics} />
      </button>
    </li>
  );
}
