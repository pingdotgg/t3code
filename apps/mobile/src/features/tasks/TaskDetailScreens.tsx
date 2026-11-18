import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type {
  OrbitSubtask,
  OrbitTaskDetail,
  OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useGT, useMessages } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { relativeTime } from "../../lib/time";
import { withKnownPullRequestSummary } from "../../state/use-thread-pr";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useNow, useOrbitTask } from "./orbitTasks";
import { useOpenTaskAgent, useOpenTaskPullRequest } from "./taskNavigation";
import {
  ROW_TONE_TINT,
  agentDot,
  agentRowStatus,
  agentsFor,
  subtaskLead,
  subtaskRowStatus,
  subtaskStatusText,
  taskStatusRow,
  tasksErrorText,
  type AgentRowModel,
} from "./taskPresentation";
import {
  AgentGlyph,
  DiffStat,
  EmptyLine,
  InfoRow,
  InfoText,
  QuietValue,
  RowStatusView,
  SectionHeading,
  StateGlyph,
  TaskListRow,
} from "./TaskRows";

type TaskTab = "overview" | "subtasks" | "agents";
type SubtaskTab = "overview" | "agents";

const OVERVIEW_ICON = "doc.text" satisfies AppSymbolName;
const SUBTASKS_ICON = "checklist" satisfies AppSymbolName;
const AGENTS_ICON: AppSymbolName = { ios: "cpu", android: "psychology" };
const USAGE_ICON: AppSymbolName = { ios: "gauge.with.dots.needle.33percent", android: "build" };

/** A detail screen's sections as a floating glass bar of icons, sized like the iPhone switcher. */
function FloatingTabs<T extends string>(props: {
  readonly value: T;
  readonly items: ReadonlyArray<{ value: T; label: string; icon: AppSymbolName }>;
  readonly onChange: (value: T) => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 items-center"
      style={{ bottom: Math.max(16, insets.bottom - 4) }}
    >
      <GlassSurface
        accessibilityRole="tablist"
        glassEffectStyle="regular"
        style={{ borderRadius: 24, flexDirection: "row", height: 48, padding: 4 }}
      >
        {props.items.map((item) => {
          const selected = item.value === props.value;
          return (
            <Pressable
              key={item.value}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected }}
              onPress={() => props.onChange(item.value)}
              className={selected ? "bg-foreground/12" : undefined}
              style={{
                width: 64,
                height: 40,
                borderRadius: 20,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <SymbolView
                name={item.icon}
                size={21}
                type="monochrome"
                tintColorClassName={selected ? "accent-foreground" : "accent-foreground-muted"}
              />
            </Pressable>
          );
        })}
      </GlassSurface>
    </View>
  );
}

/** Each tab scrolls on its own, so switching tabs opens the next one at the top. */
function TabScroll(props: {
  readonly children: ReactNode;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
      alwaysBounceVertical
    >
      {props.children}
    </ScrollView>
  );
}

function ScreenTitle(props: { readonly children: string }) {
  return (
    <Text className="px-4 pt-6 text-[24px] leading-[30px] font-t3-medium text-foreground">
      {props.children}
    </Text>
  );
}

function Brief(props: { readonly text: string }) {
  const styles = useMarkdownPreviewStyles();
  const gt = useGT();
  if (props.text.trim() === "") return <EmptyLine>{gt("No brief")}</EmptyLine>;
  return (
    <View className="px-4">
      <SelectableMarkdownText
        markdown={props.text}
        textStyle={{
          ...styles.nativeTextStyle,
          fontSize: 16,
          lineHeight: 24,
          headingFontSizes: [17, 16, 16, 16, 16, 16],
        }}
      />
    </View>
  );
}

/** A question or a block from Orbit, above the facts. */
function AttentionNotice(props: { readonly task: Pick<OrbitTaskSummary, "attention" | "status"> }) {
  const gt = useGT();
  const attention = props.task.attention;
  if (attention === null || attention.kind === "observation" || props.task.status === "completed")
    return null;
  const question = attention.kind === "question";
  const text =
    (question ? attention.question : attention.reason) ?? attention.question ?? attention.reason;
  return (
    <View
      className={
        question
          ? "mx-4 mt-4 rounded-2xl bg-warning px-4 py-3"
          : "mx-4 mt-4 rounded-2xl bg-danger px-4 py-3"
      }
    >
      <View className="flex-row items-center gap-2">
        <SymbolView
          name={question ? "questionmark.bubble" : "exclamationmark.circle"}
          size={16}
          type="monochrome"
          tintColorClassName={question ? "accent-warning-foreground" : "accent-danger-foreground"}
        />
        <Text
          className={
            question
              ? "text-[15px] font-t3-semibold text-warning-foreground"
              : "text-[15px] font-t3-semibold text-danger-foreground"
          }
        >
          {question ? gt("An agent asks") : gt("Blocked")}
        </Text>
      </View>
      {text ? <Text className="mt-1 text-[15px] text-foreground">{text}</Text> : null}
    </View>
  );
}

function SubtaskLeadGlyph(props: {
  readonly task: OrbitTaskDetail;
  readonly subtask: OrbitSubtask;
}) {
  const lead = subtaskLead(props.task, props.subtask);
  switch (lead.kind) {
    case "agent":
      return <AgentGlyph provider={lead.agent.provider} dot={lead.dot} />;
    case "working":
      return <StateGlyph name="circle.dashed" tintClassName={ROW_TONE_TINT.sky} />;
    case "done":
      return <StateGlyph name="checkmark.circle" tintClassName="accent-icon-muted" />;
    case "failed":
      return <StateGlyph name="exclamationmark.circle" tintClassName="accent-danger-foreground" />;
    case "waiting":
      return <StateGlyph name="questionmark.bubble" tintClassName="accent-warning-foreground" />;
    case "not-started":
      return <StateGlyph name="circle" tintClassName="accent-icon-muted" faded />;
  }
}

function SubtaskList(props: {
  readonly task: OrbitTaskDetail;
  readonly onOpen: (subtask: OrbitSubtask) => void;
}) {
  const gt = useGT();
  const { task } = props;
  if (task.subtasks.length === 0) return <EmptyLine>{gt("No subtasks")}</EmptyLine>;
  return task.subtasks.map((subtask) => {
    const status = subtaskRowStatus(task, subtask);
    const notStarted = subtask.status === "todo";
    const tokens = subtask.metrics.tokens;
    const duration = subtask.metrics.durationMs;
    return (
      <TaskListRow
        key={subtask.id}
        lead={<SubtaskLeadGlyph task={task} subtask={subtask} />}
        title={subtask.title}
        muted={notStarted}
        recede={status !== null && status.label === null}
        trailing={
          status ? (
            <RowStatusView status={status} />
          ) : subtask.status === "completed" && duration !== null ? (
            <QuietValue>{formatWorkingDurationLabel(duration)}</QuietValue>
          ) : null
        }
        detail={
          notStarted
            ? `#${subtask.id} · ${gt("Not started")}`
            : `#${subtask.id} · ${tokens === null ? gt("tokens –") : gt("{tokens} tokens", { tokens: formatTokens(tokens) })}`
        }
        // Orbit reports no lines per subtask today; the row shows them once it does.
        detailTrailing={
          subtask.metrics.linesAdded === null ? null : (
            <DiffStat
              added={subtask.metrics.linesAdded}
              deleted={subtask.metrics.linesDeleted}
              className="text-xs"
            />
          )
        }
        onPress={() => props.onOpen(subtask)}
      />
    );
  });
}

function AgentRows(props: { readonly rows: ReadonlyArray<AgentRowModel>; readonly empty: string }) {
  const gt = useGT();
  const m = useMessages();
  const openAgent = useOpenTaskAgent();
  const running = props.rows.some((row) => row.agent.state === "working");
  const now = useNow(running);
  if (props.rows.length === 0) return <EmptyLine>{props.empty}</EmptyLine>;
  return props.rows.map((row) => {
    const status = agentRowStatus(row.agent, now);
    const title =
      row.agent.attempt > 1
        ? gt("{role} · attempt {attempt}", { role: m(row.role), attempt: row.agent.attempt })
        : m(row.role);
    const conversation = row.conversation;
    return (
      <TaskListRow
        key={row.agent.id}
        lead={<AgentGlyph provider={row.agent.provider} dot={agentDot(row.agent)} />}
        title={title}
        recede={row.agent.state === "working"}
        trailing={
          status.label === null || status.tone !== "muted" ? (
            <RowStatusView status={status} />
          ) : (
            <QuietValue>{m(status.label)}</QuietValue>
          )
        }
        detail={[row.scope === null ? null : m(row.scope), row.agent.model]
          .filter(Boolean)
          .join(" · ")}
        accessibilityLabel={
          conversation ? undefined : gt("{title}. Conversation unavailable", { title })
        }
        {...(conversation ? { onPress: () => void openAgent(conversation) } : {})}
      />
    );
  });
}

function AgentsTab(props: { readonly task: OrbitTaskDetail; readonly subtaskId: number | null }) {
  const gt = useGT();
  const agents = agentsFor(props.task, props.subtaskId);
  return (
    <>
      <View className="pt-1" />
      <AgentRows rows={agents.current} empty={gt("No agent has started.")} />
      {agents.earlier.length > 0 ? (
        <>
          <SectionHeading title={gt("Earlier attempts")} />
          <AgentRows rows={agents.earlier} empty="" />
        </>
      ) : null}
    </>
  );
}

function LoadState(props: {
  readonly state: ReturnType<typeof useOrbitTask>["state"];
  readonly children: (task: OrbitTaskDetail) => ReactNode;
}) {
  const m = useMessages();
  if (props.state.status === "loading")
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <ActivityIndicator />
      </View>
    );
  if (props.state.status === "error") {
    const text = tasksErrorText(props.state.reason);
    return (
      <View className="flex-1 items-center justify-center gap-1 bg-screen px-8">
        <Text className="text-center text-base font-t3-medium text-foreground">
          {m(text.title)}
        </Text>
        <Text className="text-center text-[15px] text-foreground-muted">{m(text.detail)}</Text>
      </View>
    );
  }
  return props.children(props.state.value);
}

const knownTitle = (params: object) =>
  "initialSummary" in params
    ? (params.initialSummary as { readonly title?: string } | undefined)?.title
    : undefined;

function TaskOverview(props: {
  readonly task: OrbitTaskDetail;
  readonly onOpenSubtasks: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const openPullRequest = useOpenTaskPullRequest();
  const { task } = props;
  const status = taskStatusRow(task);
  const running = status.tone === "sky";
  const duration = task.metrics.durationMs;
  const pr = task.pullRequest;
  const prLink = pr ? sourceControlClients.parseChangeRequestUrl(pr.url)?.link : undefined;
  // Orbit sends no PR title; one Conn already read for a thread is shown, else the repository.
  const prTitle = prLink
    ? (knownTitle(
        withKnownPullRequestSummary({
          host: prLink.authority ?? prLink.host,
          repository: prLink.repository,
          number: prLink.number,
        }),
      ) ?? prLink.repository)
    : null;
  const done = task.subtasks.filter((subtask) => subtask.status === "completed").length;
  const now = useNow(running);
  return (
    <>
      <ScreenTitle>{task.title}</ScreenTitle>
      <AttentionNotice task={task} />
      <View className="mt-7">
        {/* Status first; the run time on the right, blue while it runs, like a working thread. */}
        <InfoRow
          icon={<StateGlyph name={status.icon} tintClassName={ROW_TONE_TINT[status.tone]} />}
          trailing={
            duration !== null ? (
              <Text
                className={
                  running
                    ? "text-[15px] font-t3-medium tabular-nums text-adaptive-sky-600-400"
                    : "text-[15px] tabular-nums text-foreground-tertiary"
                }
              >
                {formatWorkingDurationLabel(duration, m)}
              </Text>
            ) : (
              <QuietValue>{relativeTime(task.lastActivityAt ?? task.updatedAt, now, m)}</QuietValue>
            )
          }
        >
          <InfoText className="font-t3-medium">{m(status.label)}</InfoText>
        </InfoRow>
        {task.workspace ? (
          <InfoRow
            icon={<StateGlyph name="server.rack" tintClassName="accent-foreground-muted" />}
            trailing={
              task.workspace.node ? <QuietValue>{task.workspace.node.name}</QuietValue> : null
            }
          >
            {task.workspace.name}
          </InfoRow>
        ) : null}
        {task.workspace?.branch ? (
          <InfoRow
            icon={
              <StateGlyph name="arrow.triangle.branch" tintClassName="accent-foreground-muted" />
            }
          >
            <InfoText>{task.workspace.branch}</InfoText>
          </InfoRow>
        ) : null}
        {pr ? (
          <InfoRow
            icon={
              <StateGlyph
                name={
                  pr.state === "merged"
                    ? PullRequestGlyph.merged
                    : pr.state === "closed"
                      ? PullRequestGlyph.closed
                      : PullRequestGlyph.pullRequest
                }
                tintClassName={
                  pr.state === "merged"
                    ? "accent-adaptive-violet-600-400"
                    : pr.state === "closed"
                      ? "accent-danger-foreground"
                      : "accent-adaptive-emerald-600-400"
                }
              />
            }
            trailing={<QuietValue>#{pr.number}</QuietValue>}
            accessibilityLabel={gt("Pull request {number}", { number: pr.number })}
            onPress={() => openPullRequest(pr.url)}
          >
            {prTitle ?? gt("Pull request")}
          </InfoRow>
        ) : null}
        {task.metrics.tokens !== null || task.metrics.linesAdded !== null ? (
          <InfoRow
            icon={<StateGlyph name={USAGE_ICON} tintClassName="accent-foreground-muted" />}
            trailing={
              <DiffStat added={task.metrics.linesAdded} deleted={task.metrics.linesDeleted} />
            }
          >
            <InfoText className="tabular-nums text-foreground-muted">
              {task.metrics.tokens === null
                ? gt("tokens –")
                : gt("{tokens} tokens", { tokens: formatTokens(task.metrics.tokens) })}
            </InfoText>
          </InfoRow>
        ) : null}
        {task.subtasks.length > 0 ? (
          <InfoRow
            icon={<StateGlyph name={SUBTASKS_ICON} tintClassName="accent-foreground-muted" />}
            trailing={<QuietValue>{`${done}/${task.subtasks.length}`}</QuietValue>}
            onPress={props.onOpenSubtasks}
          >
            {gt("Subtasks")}
          </InfoRow>
        ) : null}
      </View>
      <SectionHeading title={gt("Brief")} />
      <Brief text={task.brief} />
    </>
  );
}

/** One Orbit task: Overview (facts and brief), Subtasks and Agents as floating tabs. */
export function OrbitTaskRouteScreen({ route }: StaticScreenProps<{ taskId: number }>) {
  const gt = useGT();
  const navigation = useNavigation();
  const taskId = Number(route.params.taskId);
  const { state, refreshing, refresh } = useOrbitTask(taskId);
  const [tab, setTab] = useState<TaskTab>("overview");
  const title =
    tab === "overview"
      ? gt("Task #{id}", { id: taskId })
      : tab === "subtasks"
        ? gt("Subtasks of #{id}", { id: taskId })
        : gt("Agents of #{id}", { id: taskId });
  const openSubtask = (subtask: OrbitSubtask) =>
    navigation.dispatch(StackActions.push("OrbitSubtask", { taskId, subtaskId: subtask.id }));
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title }} />
      <LoadState state={state}>
        {(task) => (
          <>
            <TabScroll key={tab} refreshing={refreshing} onRefresh={() => void refresh()}>
              {tab === "overview" ? (
                <TaskOverview task={task} onOpenSubtasks={() => setTab("subtasks")} />
              ) : tab === "subtasks" ? (
                <>
                  <View className="pt-1" />
                  <SubtaskList task={task} onOpen={openSubtask} />
                </>
              ) : (
                <AgentsTab task={task} subtaskId={null} />
              )}
            </TabScroll>
            <FloatingTabs
              value={tab}
              onChange={setTab}
              items={[
                { value: "overview", label: gt("Overview"), icon: OVERVIEW_ICON },
                {
                  value: "subtasks",
                  label: gt("Subtasks, {count}", { count: task.subtasks.length }),
                  icon: SUBTASKS_ICON,
                },
                {
                  value: "agents",
                  label: gt("Agents, {count}", { count: agentsFor(task, null).current.length }),
                  icon: AGENTS_ICON,
                },
              ]}
            />
          </>
        )}
      </LoadState>
    </View>
  );
}

function SubtaskOverview(props: {
  readonly task: OrbitTaskDetail;
  readonly subtask: OrbitSubtask;
  readonly onOpenTask: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { task, subtask } = props;
  const index = task.subtasks.indexOf(subtask);
  const { durationMs, tokens } = subtask.metrics;
  const started = subtask.status !== "todo";
  return (
    <>
      <ScreenTitle>{subtask.title}</ScreenTitle>
      <AttentionNotice task={{ attention: subtask.attention, status: task.status }} />
      <View className="mt-7">
        <InfoRow
          icon={<SubtaskLeadGlyph task={task} subtask={subtask} />}
          trailing={
            <QuietValue>
              {gt("{position} of {total}", { position: index + 1, total: task.subtasks.length })}
            </QuietValue>
          }
        >
          <InfoText className="font-t3-medium">{m(subtaskStatusText(task, subtask))}</InfoText>
        </InfoRow>
        {/* The parent task is a row, not a line above the title; Back returns to it too. */}
        <InfoRow
          icon={<StateGlyph name={SUBTASKS_ICON} tintClassName="accent-foreground-muted" />}
          trailing={<QuietValue>#{task.id}</QuietValue>}
          onPress={props.onOpenTask}
        >
          {task.title}
        </InfoRow>
        {started ? (
          <InfoRow
            icon={<StateGlyph name={USAGE_ICON} tintClassName="accent-foreground-muted" />}
            trailing={
              subtask.metrics.linesAdded === null ? null : (
                <DiffStat
                  added={subtask.metrics.linesAdded}
                  deleted={subtask.metrics.linesDeleted}
                />
              )
            }
          >
            <InfoText className="tabular-nums text-foreground-muted">
              {[
                durationMs === null ? "–" : formatWorkingDurationLabel(durationMs, m),
                tokens === null
                  ? gt("tokens –")
                  : gt("{tokens} tokens", { tokens: formatTokens(tokens) }),
              ].join(" · ")}
            </InfoText>
          </InfoRow>
        ) : null}
      </View>
      <SectionHeading title={gt("Brief")} />
      <Brief text={subtask.brief} />
      {subtask.deliverables.length > 0 ? (
        <>
          <SectionHeading title={gt("Deliverables")} />
          {subtask.deliverables.map((item) => (
            <InfoRow
              key={item.id}
              multiline
              icon={<View className="ml-1.5 h-1.5 w-1.5 rounded-full bg-foreground-muted" />}
            >
              {item.description}
            </InfoRow>
          ))}
        </>
      ) : null}
    </>
  );
}

/** One subtask: Overview (status, parent, usage, brief, deliverables) and Agents. */
export function OrbitSubtaskRouteScreen({
  route,
}: StaticScreenProps<{ taskId: number; subtaskId: number }>) {
  const gt = useGT();
  const navigation = useNavigation();
  const taskId = Number(route.params.taskId);
  const subtaskId = Number(route.params.subtaskId);
  const { state, refreshing, refresh } = useOrbitTask(taskId);
  const [tab, setTab] = useState<SubtaskTab>("overview");
  const title =
    tab === "overview"
      ? gt("Subtask #{id}", { id: subtaskId })
      : gt("Agents of #{id}", { id: subtaskId });
  const openTask = () => {
    const routes = navigation.getState()?.routes ?? [];
    const previous = routes.at(-2);
    if (
      previous?.name === "OrbitTask" &&
      Number((previous.params as { taskId?: number } | undefined)?.taskId) === taskId
    )
      navigation.goBack();
    else navigation.dispatch(StackActions.push("OrbitTask", { taskId }));
  };
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title }} />
      <LoadState state={state}>
        {(task) => {
          const subtask = task.subtasks.find((item) => item.id === subtaskId);
          if (!subtask)
            return <EmptyLine>{gt("This subtask is no longer part of the task.")}</EmptyLine>;
          return (
            <>
              <TabScroll key={tab} refreshing={refreshing} onRefresh={() => void refresh()}>
                {tab === "overview" ? (
                  <SubtaskOverview task={task} subtask={subtask} onOpenTask={openTask} />
                ) : (
                  <AgentsTab task={task} subtaskId={subtask.id} />
                )}
              </TabScroll>
              <FloatingTabs
                value={tab}
                onChange={setTab}
                items={[
                  { value: "overview", label: gt("Overview"), icon: OVERVIEW_ICON },
                  {
                    value: "agents",
                    label: gt("Agents, {count}", {
                      count: agentsFor(task, subtask.id).current.length,
                    }),
                    icon: AGENTS_ICON,
                  },
                ]}
              />
            </>
          );
        }}
      </LoadState>
    </View>
  );
}
