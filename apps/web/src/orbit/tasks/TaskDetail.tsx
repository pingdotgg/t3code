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
  FileDiffIcon,
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

import { T, useGT, useMessages } from "gt-react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "~/components/chat/threadDetailsPanelStyles";
import {
  PullRequestDiffStat,
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
} from "~/components/pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { usePullRequestPreviewTarget } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { pullRequestEnvironment, useSharedPullRequestSummary } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
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
 * One scroller, like the PR panel: the title stays put, the key-value list scrolls away under it,
 * and the tabs stick right below the title.
 */
function TaskDetailBody(props: {
  threadKey: string;
  navigation: TasksNavigation;
  task: OrbitTaskDetail;
}) {
  const { task, navigation } = props;
  const actions = use(NavigationContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- puts the DOM scroller back where the store says when the shown brief or tab changes
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = navigation.detailScrollTop;
  }, [navigation.detailScrollTop]);
  const subtask =
    navigation.subtaskId === null
      ? null
      : (task.subtasks.find((entry) => entry.id === navigation.subtaskId) ?? null);
  const saveCurrentScroll = () =>
    tasksPanelActions().saveDetailScroll(props.threadKey, scrollRef.current?.scrollTop ?? 0);
  const openAgent = async (ref: Parameters<NonNullable<typeof actions>["openAgent"]>[0]) => {
    saveCurrentScroll();
    await actions?.openAgent(ref);
  };
  const openPullRequest = (url: string) => {
    saveCurrentScroll();
    actions?.openPullRequest(url);
  };
  // A subtask has no Subtasks tab; the task's own tab comes back on the way up.
  const tab = subtask && navigation.tab === "subtasks" ? "brief" : navigation.tab;
  return (
    <NavigationContext value={actions ? { ...actions, openAgent, openPullRequest } : null}>
      <div
        ref={scrollRef}
        role="region"
        aria-label="Task detail"
        tabIndex={0}
        onScrollEnd={(event) => {
          if (event.target === event.currentTarget) saveCurrentScroll();
        }}
        className="scrollbar-inset min-h-0 flex-1 overflow-y-auto px-4.5 pt-4 pb-8 outline-none"
      >
        <TaskPage threadKey={props.threadKey} task={task} subtask={subtask} tab={tab} />
      </div>
    </NavigationContext>
  );
}

/**
 * The page in the scroller. It is at least tall enough for the key-value list to scroll fully
 * away, so the tabs always reach the title, even under a short brief.
 */
function TaskPage(props: {
  threadKey: string;
  task: OrbitTaskDetail;
  subtask: OrbitSubtask | null;
  tab: TasksDetailTab;
}) {
  const { task, subtask } = props;
  const articleRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const travelRef = useRef<HTMLDivElement>(null);
  const [titleHeight, setTitleHeight] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the sticky tabs sit under the measured title, and the page grows to the scroller's measured height
  useLayoutEffect(() => {
    const article = articleRef.current;
    const scroller = article?.parentElement;
    const title = titleRef.current;
    const travel = travelRef.current;
    if (!article || !scroller || !title || !travel) return;
    const measure = () => {
      const style = getComputedStyle(scroller);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // Set here, not rendered, so the parent's scroll restore already sees the full height.
      // One pixel more, because the stuck tabs overlap the title's line.
      const height = scroller.clientHeight - padding + travel.offsetHeight + 1;
      article.style.minHeight = `${Math.max(0, height)}px`;
      setTitleHeight(title.offsetHeight);
    };
    measure();
    return observeResize([scroller, title, travel], measure);
  }, []);
  const agents = agentsFor(task, subtask?.id ?? null);
  return (
    <article ref={articleRef} className="flex flex-col">
      {/* Sticky at the scroller's padding edge, so it covers what scrolls under it. */}
      <div
        ref={titleRef}
        className={cn(
          "sticky -top-4 z-20 -mx-4.5 -mt-4 bg-background px-4.5 py-4",
          !subtask && "border-b border-(--shell-divider)!",
        )}
      >
        <h2 className="m-0 text-lg leading-6 font-medium text-foreground [overflow-wrap:anywhere]">
          {subtask ? subtask.title : task.title}
        </h2>
      </div>
      {/* What scrolls away before the tabs stick: the key-value list and the space above the tabs. */}
      <div ref={travelRef} className="pb-4">
        {subtask ? null : (
          <div className="pt-4">
            <TaskKeyValues task={task} />
          </div>
        )}
      </div>
      <TaskTabs
        threadKey={props.threadKey}
        task={task}
        subtask={subtask}
        tab={props.tab}
        agents={agents.current.length + agents.earlier.length}
        // The stuck row's top line slides 1px under the title's line.
        stickyTop={titleHeight - 17}
      />
      <div className="pt-4.5">
        {props.tab === "agents" ? (
          <AgentsList agents={agents} />
        ) : props.tab === "subtasks" && !subtask ? (
          <SubtasksList threadKey={props.threadKey} task={task} />
        ) : (
          <TaskBrief task={task} subtask={subtask} />
        )}
      </div>
    </article>
  );
}

function TaskBrief(props: { task: OrbitTaskDetail; subtask: OrbitSubtask | null }) {
  const { task, subtask } = props;
  const attention = subtask ? subtask.attention : task.attention;
  const attentionText =
    attention && attention.kind !== "observation" ? (attention.question ?? attention.reason) : null;
  const brief = subtask ? subtask.brief : task.brief;
  return (
    <div className={cn("flex flex-col gap-6", subtask ? "-mt-1.5" : "pt-1")}>
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
      {brief.trim().length > 0 ? (
        // The tab names the brief, so it has no heading; its own headings stay body size.
        <div
          className={cn(
            "[&_:is(h1,h2,h3,h4,h5,h6)]:text-sm! [&_:is(h1,h2,h3,h4,h5,h6)]:font-medium! [&>*:first-child>*:first-child]:mt-0!",
            subtask && "mt-2.5",
          )}
        >
          <ChatMarkdown text={brief} cwd={undefined} headingLevelOffset={2} />
        </div>
      ) : (
        <p className="m-0 text-ui text-muted-foreground">
          <T>No brief.</T>
        </p>
      )}
      {subtask && subtask.deliverables.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h3 className="m-0 text-base leading-6 font-medium text-foreground">
            <T>Deliverables</T>
          </h3>
          <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-sm text-foreground/85">
            {subtask.deliverables.map((item) => (
              <li key={item.id}>{item.description}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Line tabs, 47px between the lines, the line edge to edge; sticky under the title. */
function TaskTabs(props: {
  threadKey: string;
  task: OrbitTaskDetail;
  subtask: OrbitSubtask | null;
  tab: TasksDetailTab;
  agents: number;
  stickyTop: number;
}) {
  const gt = useGT();
  const done = props.task.subtasks.filter((subtask) => subtask.status === "completed").length;
  return (
    <div
      role="tablist"
      aria-label={gt("Show")}
      style={{ top: props.stickyTop }}
      className={cn(
        "sticky z-10 -mx-4.5 flex items-center gap-5 border-b border-(--shell-divider)! bg-background px-4.5",
        // Task level: a line above the tabs too, like the PR header.
        props.subtask ? null : "border-t",
      )}
    >
      <ContentTab threadKey={props.threadKey} tab="brief" selected={props.tab === "brief"}>
        <T>Brief</T>
      </ContentTab>
      {props.subtask ? null : (
        <ContentTab threadKey={props.threadKey} tab="subtasks" selected={props.tab === "subtasks"}>
          <T>Subtasks</T>
          <span className="font-normal text-muted-foreground tabular-nums">
            {done}/{props.task.subtasks.length}
          </span>
        </ContentTab>
      )}
      <ContentTab threadKey={props.threadKey} tab="agents" selected={props.tab === "agents"}>
        <T>Agents</T>
        <span className="font-normal text-muted-foreground tabular-nums">{props.agents}</span>
      </ContentTab>
    </div>
  );
}

/** A subtask's Brief opens with its status and usage, the rows the task keeps in its header. */
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
        "-mb-px flex h-12 cursor-pointer items-center gap-1.5 border-b-2 px-0.5 text-sm font-medium transition-colors outline-none focus-visible:text-foreground",
        props.selected
          ? "border-foreground/80 text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground/85",
      )}
    >
      {props.children}
    </button>
  );
}

/** The Subtasks tab: a row opens the subtask; its agent icon opens the subtask's Agents tab. */
function SubtasksList(props: { threadKey: string; task: OrbitTaskDetail }) {
  const { task } = props;
  return task.subtasks.length > 0 ? (
    <ul className="-mx-2.5 -mt-2.25 m-0 flex list-none flex-col gap-0.5 p-0">
      {task.subtasks.map((subtask) => (
        <SubtaskRow key={subtask.id} threadKey={props.threadKey} task={task} subtask={subtask} />
      ))}
    </ul>
  ) : (
    <p className="m-0 text-ui text-muted-foreground">
      <T>No subtasks yet.</T>
    </p>
  );
}

function AgentsList(props: { agents: ReturnType<typeof agentsFor> }) {
  const { current, earlier } = props.agents;
  return (
    <div className="-mt-2.5 flex flex-col gap-6">
      {current.length > 0 ? (
        <ul className="-mx-2.5 m-0 list-none p-0">
          {current.map((row) => (
            <AgentRow key={row.agent.id} row={row} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-ui text-muted-foreground">
          <T>No agent has started.</T>
        </p>
      )}
      {earlier.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-medium text-muted-foreground">
            <T>Earlier attempts</T>
          </h3>
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

const ROW = cn(
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  "flex items-center font-normal text-muted-foreground",
);

/** One key-value row, the same grid as the PR header's. */
function TaskMetaRow(props: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-2 text-sm">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {props.icon}
        {props.label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-foreground">{props.children}</span>
    </div>
  );
}

/** Where the task runs, its branch and PR, and what it cost: rows under the title, like a PR. */
function TaskKeyValues(props: { task: OrbitTaskDetail }) {
  const gt = useGT();
  const { task } = props;
  const environment = orbitTaskEnvironment(task);
  const usage = taskUsage(task.metrics);
  const machine = task.workspace?.node?.name ?? null;
  const state =
    environment.kind === "disposed"
      ? gt("removed")
      : environment.kind === "stopped"
        ? gt("asleep")
        : environment.kind === "unreachable"
          ? gt("offline")
          : null;
  const icon = "size-3.5 shrink-0";
  return (
    <div className="flex flex-col gap-2">
      <TaskMetaRow icon={<ServerIcon aria-hidden className={icon} />} label={gt("Workspace")}>
        {task.workspace ? (
          <>
            <span className="truncate">{task.workspace.name}</span>
            {machine || state ? (
              <span
                className={cn(
                  "shrink-0",
                  environment.kind === "disposed" || environment.kind === "unreachable"
                    ? "text-destructive-foreground"
                    : "text-muted-foreground",
                )}
              >
                {[machine ? gt("on {machine}", { machine }) : null, state]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">
            {environment.kind === "not-started" ? gt("No workspace yet") : gt("Removed")}
          </span>
        )}
      </TaskMetaRow>
      {task.workspace?.branch ? (
        <TaskMetaRow icon={<GitBranchIcon aria-hidden className={icon} />} label={gt("Branch")}>
          <span className="truncate text-muted-foreground">{task.workspace.branch}</span>
        </TaskMetaRow>
      ) : null}
      {task.pullRequest ? (
        <TaskMetaRow
          icon={<PullRequestGlyph.pullRequest aria-hidden className={icon} />}
          label={gt("Pull request")}
        >
          <TaskPullRequestValue pr={task.pullRequest} />
        </TaskMetaRow>
      ) : null}
      <TaskMetaRow icon={<GaugeIcon aria-hidden className={icon} />} label={gt("Usage")}>
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={<span tabIndex={0} className="truncate tabular-nums outline-none" />}
          >
            {usage.text}
          </TooltipTrigger>
          <TooltipPopup side="bottom" className="max-w-72">
            {usage.description}
          </TooltipPopup>
        </Tooltip>
      </TaskMetaRow>
      <TaskMetaRow icon={<FileDiffIcon aria-hidden className={icon} />} label={gt("Changes")}>
        {usage.lines === null ? (
          <span className="text-muted-foreground">{gt("Not reported yet")}</span>
        ) : usage.lines.added === 0 && usage.lines.deleted === 0 ? (
          <span className="text-muted-foreground">{gt("No changes")}</span>
        ) : (
          <PullRequestDiffStat additions={usage.lines.added} deletions={usage.lines.deleted} />
        )}
      </TaskMetaRow>
    </div>
  );
}

/**
 * Title and checks come from the PR's environment when Conn can read it there (Orbit sends only
 * number, URL and state); without it the state names the PR.
 */
function useTaskPullRequestCard(url: string) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const target = usePullRequestPreviewTarget(primaryEnvironmentId, url);
  const preview = useEnvironmentQuery(
    target
      ? pullRequestEnvironment.previewCard({
          environmentId: target.environmentId,
          input: target.input,
        })
      : null,
  ).data;
  const summary = useSharedPullRequestSummary(target?.environmentId ?? null, target?.input ?? null);
  return {
    title: preview?.title ?? summary?.title ?? null,
    checks: summary?.checksState ?? null,
  };
}

/** The task's PR. Opening it is one handler, `openPullRequest` from the navigation context. */
function TaskPullRequestValue(props: { pr: NonNullable<OrbitTaskDetail["pullRequest"]> }) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = use(NavigationContext);
  const { pr } = props;
  const card = useTaskPullRequestCard(pr.url);
  const state = pr.state
    ? resolvePullRequestState({ state: pr.state, isDraft: false }, messages)
    : null;
  const checks =
    pr.state === "open" && card.checks
      ? pullRequestChecksStatePresentation(card.checks, messages)
      : null;
  const Icon = state?.Icon;
  return (
    <>
      <button
        type="button"
        onClick={() => navigation?.openPullRequest(pr.url)}
        aria-label={gt("Pull request #{number}. {state}. Open in the pull request panel", {
          number: pr.number,
          state: state?.label ?? gt("State unknown"),
        })}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
      >
        {Icon ? (
          <Icon aria-hidden className={cn("size-3.5 shrink-0", state.toneClassName)} />
        ) : (
          <PullRequestGlyph.pullRequest className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{card.title ?? state?.label ?? gt("Pull request")}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">#{pr.number}</span>
      </button>
      {checks ? (
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={<span tabIndex={0} className="flex shrink-0 outline-none" />}
          >
            <checks.Icon aria-hidden className={cn("size-3.5", checks.toneClassName)} />
            <span className="sr-only">{checks.label}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">{checks.label}</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
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
 * A subtask: the row opens its Brief; an agent icon in front opens its Agents tab. Lines and
 * the quiet line show a dash for what Orbit does not report, and stay off until it starts.
 */
function SubtaskRow(props: { threadKey: string; task: OrbitTaskDetail; subtask: OrbitSubtask }) {
  const { subtask } = props;
  const lead = subtaskLead(props.task, subtask);
  const usage = subtaskUsageText(subtask.metrics);
  const status = subtaskStatusText(subtask, props.task);
  return (
    <li className="flex items-start rounded-lg hover:bg-(--shell-highlight)">
      {lead.kind === "agent" ? (
        <button
          type="button"
          aria-label={`${status}. Agents for ${subtask.title}`}
          onClick={() => tasksPanelActions().openSubtask(props.threadKey, subtask.id, "agents")}
          className="ms-2.25 mt-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-(--shell-highlight) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
        >
          <SubtaskLeadIcon lead={lead} />
        </button>
      ) : (
        <span
          className="ms-2.25 mt-1.5 flex size-5 shrink-0 items-center justify-center"
          aria-label={status}
        >
          <SubtaskLeadIcon lead={lead} />
        </span>
      )}
      <button
        type="button"
        aria-label={`${subtask.title}. ${status}.${usage ? ` ${usage}.` : ""} Open subtask`}
        onClick={() => tasksPanelActions().openSubtask(props.threadKey, subtask.id)}
        className="flex min-w-0 flex-1 cursor-pointer flex-col rounded-lg py-1.5 ps-2 pe-2.5 text-left text-ui focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
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
          {lead.kind === "not-started" ? null : <SubtaskDiff metrics={subtask.metrics} />}
        </span>
        {lead.kind === "not-started" ? null : <SubtaskMeta metrics={subtask.metrics} />}
      </button>
    </li>
  );
}
