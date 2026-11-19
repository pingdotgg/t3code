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
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { withKnownPullRequestSummary } from "../../state/use-thread-pr";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import {
  DetailHeader,
  DockedTabs,
  KvIcon,
  KvRow,
  KvText,
  LineTabs,
  useDockedTabs,
  type LineTab,
} from "../detail/DetailLayout";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";
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
  QuietValue,
  RowStatusView,
  SectionHeading,
  StateGlyph,
  TaskListRow,
} from "./TaskRows";

type TaskTab = "brief" | "subtasks" | "agents";
type SubtaskTab = "brief" | "agents";

const USAGE_ICON: AppSymbolName = { ios: "gauge.with.dots.needle.33percent", android: "build" };

/**
 * A detail page: title and key-value rows scroll away, the tabs then stay under the bar. Short
 * tabs still leave room for the rows to scroll away, so switching tabs never moves the tabs.
 */
function DetailScroll(props: {
  readonly header: ReactNode;
  readonly tabs: ReactNode;
  readonly children: ReactNode;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const insets = useSafeAreaInsets();
  const docked = useDockedTabs();
  const [viewportHeight, setViewportHeight] = useState(0);
  return (
    <View
      className="flex-1"
      onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
    >
      <ScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingBottom: insets.bottom + 24,
          minHeight: docked.dockOffset === null ? undefined : docked.dockOffset + viewportHeight,
        }}
        onScroll={(event) => docked.onScrollOffset(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />
        }
        alwaysBounceVertical
      >
        <View onLayout={docked.onHeaderLayout}>{props.header}</View>
        {props.tabs}
        <View className="pt-3">{props.children}</View>
      </ScrollView>
      <DockedTabs docked={docked}>{props.tabs}</DockedTabs>
    </View>
  );
}

function Brief(props: { readonly text: string }) {
  const styles = useMarkdownPreviewStyles();
  const gt = useGT();
  if (props.text.trim() === "") return <EmptyLine>{gt("No brief")}</EmptyLine>;
  return (
    <View className="px-4 pt-1">
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

/** A question or a block from Orbit, under the title line. */
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

const agentCount = (task: OrbitTaskDetail, subtaskId: number | null) => {
  const agents = agentsFor(task, subtaskId);
  return agents.current.length + agents.earlier.length;
};

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

function UsageRows(props: {
  readonly metrics: OrbitTaskDetail["metrics"];
  readonly showDuration: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const { durationMs, tokens, linesAdded, linesDeleted } = props.metrics;
  if (tokens === null && linesAdded === null && !(props.showDuration && durationMs !== null))
    return null;
  const tokensText =
    tokens === null ? gt("tokens –") : gt("{tokens} tokens", { tokens: formatTokens(tokens) });
  return (
    <>
      <KvRow icon={<KvIcon name={USAGE_ICON} />} label={gt("Usage")}>
        <KvText className="tabular-nums">
          {props.showDuration
            ? [
                durationMs === null ? "–" : formatWorkingDurationLabel(durationMs, m),
                tokensText,
              ].join(" · ")
            : tokensText}
        </KvText>
      </KvRow>
      {linesAdded !== null ? (
        <KvRow icon={<KvIcon name="plusminus" />} label={gt("Changes")}>
          <DiffStat added={linesAdded} deleted={linesDeleted} className="text-[15px]" />
        </KvRow>
      ) : null}
    </>
  );
}

function TaskRows(props: { readonly task: OrbitTaskDetail }) {
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
  const prStatus = pr ? pullRequestStatus({ state: pr.state ?? "open", isDraft: false }, m) : null;
  return (
    <>
      <KvRow
        icon={<StateGlyph name={status.icon} tintClassName={ROW_TONE_TINT[status.tone]} />}
        label={gt("Status")}
      >
        <KvText className="shrink-0">{m(status.label)}</KvText>
        {duration !== null ? (
          <KvText
            className={
              running
                ? "tabular-nums text-adaptive-sky-600-400"
                : "tabular-nums text-foreground-muted"
            }
          >
            · {formatWorkingDurationLabel(duration, m)}
          </KvText>
        ) : null}
      </KvRow>
      {task.workspace ? (
        <KvRow icon={<KvIcon name="server.rack" />} label={gt("Workspace")}>
          <KvText>{task.workspace.name}</KvText>
          {task.workspace.node ? (
            <KvText className="shrink-0 text-foreground-muted">
              {gt("on {node}", { node: task.workspace.node.name })}
            </KvText>
          ) : null}
        </KvRow>
      ) : null}
      {task.workspace?.branch ? (
        <KvRow icon={<KvIcon name="arrow.triangle.branch" />} label={gt("Branch")}>
          <KvText className="text-foreground-muted">{task.workspace.branch}</KvText>
        </KvRow>
      ) : null}
      {pr && prStatus ? (
        <KvRow
          icon={<KvIcon name={PullRequestGlyph.pullRequest} />}
          label={gt("Pull request")}
          accessibilityLabel={gt("Pull request {number}", { number: pr.number })}
          onPress={() => openPullRequest(pr.url, { id: task.id, title: task.title })}
        >
          <SymbolView
            name={prStatus.icon}
            size={16}
            type="monochrome"
            weight="medium"
            tintColorClassName={prStatus.tint}
          />
          <KvText>{prTitle ?? gt("Pull request")}</KvText>
          <KvText className="ml-auto shrink-0 tabular-nums text-foreground-muted">
            #{pr.number}
          </KvText>
        </KvRow>
      ) : null}
      <UsageRows metrics={task.metrics} showDuration={false} />
    </>
  );
}

/** One Orbit task: title and facts, then Brief · Subtasks · Agents as tabs. */
export function OrbitTaskRouteScreen({ route }: StaticScreenProps<{ taskId: number }>) {
  const gt = useGT();
  const navigation = useNavigation();
  const taskId = Number(route.params.taskId);
  const { state, refreshing, refresh } = useOrbitTask(taskId);
  const [tab, setTab] = useState<TaskTab>("brief");
  const openSubtask = (subtask: OrbitSubtask) =>
    navigation.dispatch(StackActions.push("OrbitSubtask", { taskId, subtaskId: subtask.id }));
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: gt("Task #{id}", { id: taskId }) }} />
      <LoadState state={state}>
        {(task) => {
          const done = task.subtasks.filter((subtask) => subtask.status === "completed").length;
          const agents = agentCount(task, null);
          const items: ReadonlyArray<LineTab<TaskTab>> = [
            { value: "brief", label: gt("Brief") },
            {
              value: "subtasks",
              label: gt("Subtasks"),
              count: `${done}/${task.subtasks.length}`,
              accessibilityLabel: gt("Subtasks, {done} of {total} done", {
                done,
                total: task.subtasks.length,
              }),
            },
            {
              value: "agents",
              label: gt("Agents"),
              count: String(agents),
              accessibilityLabel: gt("Agents, {count}", { count: agents }),
            },
          ];
          return (
            <DetailScroll
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              header={
                <DetailHeader title={task.title} notice={<AttentionNotice task={task} />}>
                  <TaskRows task={task} />
                </DetailHeader>
              }
              tabs={<LineTabs value={tab} items={items} onChange={setTab} />}
            >
              {tab === "brief" ? (
                <Brief text={task.brief} />
              ) : tab === "subtasks" ? (
                <SubtaskList task={task} onOpen={openSubtask} />
              ) : (
                <AgentsTab task={task} subtaskId={null} />
              )}
            </DetailScroll>
          );
        }}
      </LoadState>
    </View>
  );
}

/** One subtask: status, its task, usage, then Brief (with deliverables) · Agents. */
export function OrbitSubtaskRouteScreen({
  route,
}: StaticScreenProps<{ taskId: number; subtaskId: number }>) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const taskId = Number(route.params.taskId);
  const subtaskId = Number(route.params.subtaskId);
  const { state, refreshing, refresh } = useOrbitTask(taskId);
  const [tab, setTab] = useState<SubtaskTab>("brief");
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
      <NativeStackScreenOptions options={{ title: gt("Subtask #{id}", { id: subtaskId }) }} />
      <LoadState state={state}>
        {(task) => {
          const subtask = task.subtasks.find((item) => item.id === subtaskId);
          if (!subtask)
            return <EmptyLine>{gt("This subtask is no longer part of the task.")}</EmptyLine>;
          const index = task.subtasks.indexOf(subtask);
          const agents = agentCount(task, subtask.id);
          return (
            <DetailScroll
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              header={
                <DetailHeader
                  title={subtask.title}
                  notice={
                    <AttentionNotice task={{ attention: subtask.attention, status: task.status }} />
                  }
                >
                  <KvRow
                    icon={<SubtaskLeadGlyph task={task} subtask={subtask} />}
                    label={gt("Status")}
                  >
                    <KvText className="shrink-0">{m(subtaskStatusText(task, subtask))}</KvText>
                    <KvText className="tabular-nums text-foreground-muted">
                      ·{" "}
                      {gt("{position} of {total}", {
                        position: index + 1,
                        total: task.subtasks.length,
                      })}
                    </KvText>
                  </KvRow>
                  {/* The parent task, a level up: the same as Back when it is below. */}
                  <KvRow icon={<KvIcon name="checklist" />} label={gt("Task")} onPress={openTask}>
                    <KvText className="shrink-0 tabular-nums text-foreground-muted">
                      #{task.id}
                    </KvText>
                    <KvText>{task.title}</KvText>
                  </KvRow>
                  {subtask.status !== "todo" ? (
                    <UsageRows metrics={subtask.metrics} showDuration />
                  ) : null}
                </DetailHeader>
              }
              tabs={
                <LineTabs
                  value={tab}
                  onChange={setTab}
                  items={[
                    { value: "brief", label: gt("Brief") },
                    {
                      value: "agents",
                      label: gt("Agents"),
                      count: String(agents),
                      accessibilityLabel: gt("Agents, {count}", { count: agents }),
                    },
                  ]}
                />
              }
            >
              {tab === "brief" ? (
                <>
                  <Brief text={subtask.brief} />
                  {subtask.deliverables.length > 0 ? (
                    <>
                      <SectionHeading title={gt("Deliverables")} />
                      {subtask.deliverables.map((item) => (
                        <InfoRow
                          key={item.id}
                          multiline
                          icon={
                            <View className="ml-1.5 h-1.5 w-1.5 rounded-full bg-foreground-muted" />
                          }
                        >
                          {item.description}
                        </InfoRow>
                      ))}
                    </>
                  ) : null}
                </>
              ) : (
                <AgentsTab task={task} subtaskId={subtask.id} />
              )}
            </DetailScroll>
          );
        }}
      </LoadState>
    </View>
  );
}
