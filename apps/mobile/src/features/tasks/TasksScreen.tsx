import { StackActions, useNavigation } from "@react-navigation/native";
import type { OrbitTaskLane, OrbitTaskSummary } from "@t3tools/client-runtime/orbit-gateway";
import { useGT, useMessages } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";

import { RefreshControl } from "../../components/ui/RefreshControl";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { relativeTime } from "../../lib/time";
import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { WorkspacePhoneBar } from "../layout/workspace/WorkspacePhoneBar";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { useWorkspacePhoneBar } from "../layout/workspace/useWorkspacePhoneBar";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useNow, useOrbitTaskList } from "./orbitTasks";
import {
  MOBILE_TASK_LANES,
  TASK_LANE_LABELS,
  taskMatchesQuery,
  taskRowStatus,
  tasksErrorText,
  tasksInLane,
} from "./taskPresentation";
import { ProjectTile, QuietValue, RowStatusView, TaskListRow } from "./TaskRows";

/** The lane survives leaving the tab, like the other lists' filters. */
let rememberedLane: OrbitTaskLane = "in-progress";
function rememberLane(lane: OrbitTaskLane) {
  rememberedLane = lane;
}

const BAR_HEIGHT = 56;

function TaskRow(props: {
  readonly task: OrbitTaskSummary;
  readonly durationMs: number | null;
  readonly now: number;
  readonly onPress: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { task } = props;
  const { total, completed } = task.subtaskCounts;
  const status = taskRowStatus(task, props.durationMs);
  const pr = task.pullRequest;
  const prTone =
    pr?.state === "merged"
      ? "text-adaptive-violet-600-400"
      : pr?.state === "closed"
        ? "text-danger-foreground"
        : "text-adaptive-emerald-700-300";
  const prTint =
    pr?.state === "merged"
      ? "accent-adaptive-violet-600-400"
      : pr?.state === "closed"
        ? "accent-danger-foreground"
        : "accent-adaptive-emerald-700-300";
  const detail = [
    `#${task.id}`,
    total > 0 ? gt("{done}/{total} subtasks", { done: completed, total }) : null,
    task.workspace?.node?.name ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <TaskListRow
      accessibilityLabel={[
        task.title,
        status?.label ? m(status.label) : null,
        detail,
        pr ? gt("Pull request {number}", { number: pr.number }) : null,
      ]
        .filter(Boolean)
        .join(", ")}
      lead={<ProjectTile name={task.project.name} />}
      title={task.title}
      recede={status !== null && status.label === null}
      trailing={
        status ? (
          <RowStatusView status={status} />
        ) : (
          <QuietValue>
            {relativeTime(task.lastActivityAt ?? task.updatedAt, props.now, m)}
          </QuietValue>
        )
      }
      detail={detail}
      detailTrailing={
        pr ? (
          <View className="flex-row items-center gap-1">
            <SymbolView
              name={pr.state === "merged" ? PullRequestGlyph.merged : PullRequestGlyph.pullRequest}
              size={12}
              type="monochrome"
              tintColorClassName={prTint}
            />
            <Text className={`text-sm tabular-nums ${prTone}`}>#{pr.number}</Text>
          </View>
        ) : null
      }
      onPress={props.onPress}
    />
  );
}

/** Tasks Orbit tracks, one lane at a time; the lanes sit behind the filter button. */
export function TasksScreen() {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const workspace = useWorkspaceTabs();
  const connPhoneBar = useWorkspacePhoneBar();
  const [lane, setLaneState] = useState<OrbitTaskLane>(rememberedLane);
  const setLane = (next: OrbitTaskLane) => {
    rememberLane(next);
    setLaneState(next);
  };
  const { state, durations, refreshing, refresh } = useOrbitTaskList();
  const now = useNow(true);
  const searchTab = workspace?.state.tabs.tasks;
  const query = searchTab && searchTab.searchMode !== "resting" ? searchTab.query : "";
  const all =
    state.status === "ok" ? state.value.filter((task) => taskMatchesQuery(task, query)) : [];
  const visible = tasksInLane(all, lane);
  const open = (task: OrbitTaskSummary) =>
    navigation.dispatch(StackActions.push("OrbitTask", { taskId: task.id }));

  const laneActions = MOBILE_TASK_LANES.map((id) => ({
    id,
    title: m(TASK_LANE_LABELS[id]),
    subtitle: String(tasksInLane(all, id).length),
    state: id === lane ? ("on" as const) : ("off" as const),
  }));
  const filterMenu: HomeListFilterMenu = {
    title: gt("Lanes"),
    items: laneActions.map((action) => ({
      type: "action",
      title: action.title,
      subtitle: action.subtitle,
      state: action.state,
      onPress: () => setLane(action.id),
    })),
  };
  // The bar sits where a native one would: its middle 28pt below the safe area's top.
  const topInset = Math.max(0, insets.top - 8);
  const bottomClearance = workspace?.bottomClearance ?? insets.bottom + 16;

  return (
    <View className="flex-1 bg-screen">
      {connPhoneBar ? (
        <WorkspacePhoneBar filterMenu={filterMenu} filterActive={lane !== "in-progress"} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: topInset + BAR_HEIGHT + 4,
          paddingBottom: bottomClearance,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            progressViewOffset={topInset + BAR_HEIGHT}
          />
        }
        alwaysBounceVertical
      >
        {state.status === "loading" ? (
          <ActivityIndicator className="mt-10" />
        ) : state.status === "error" ? (
          <View className="items-center gap-1 px-8 py-10">
            <Text className="text-center text-base font-t3-medium text-foreground">
              {m(tasksErrorText(state.reason).title)}
            </Text>
            <Text className="text-center text-[15px] text-foreground-muted">
              {m(tasksErrorText(state.reason).detail)}
            </Text>
          </View>
        ) : visible.length === 0 ? (
          <Text className="px-8 py-10 text-center text-[15px] text-foreground-muted">
            {query ? gt("No matching tasks") : gt("Nothing here")}
          </Text>
        ) : (
          visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              durationMs={durations.get(task.id) ?? null}
              now={now}
              onPress={() => open(task)}
            />
          ))
        )}
      </ScrollView>
      <TasksTopBar
        top={topInset}
        title={gt("Tasks")}
        subtitle={state.status === "ok" ? `${m(TASK_LANE_LABELS[lane])} · ${visible.length}` : null}
        menu={
          <Menu
            actions={laneActions}
            onPressAction={({ nativeEvent }) => {
              const next = MOBILE_TASK_LANES.find((id) => id === nativeEvent.event);
              if (next) setLane(next);
            }}
          >
            <GlassCircle
              accessibilityLabel={gt("Filter tasks")}
              icon="line.3.horizontal.decrease"
            />
          </Menu>
        }
      />
    </View>
  );
}

function GlassCircle(props: {
  readonly accessibilityLabel: string;
  readonly icon: "line.3.horizontal.decrease";
}) {
  return (
    <GlassSurface
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      glassEffectStyle="regular"
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <SymbolView
        name={props.icon}
        size={19}
        type="monochrome"
        tintColorClassName="accent-foreground"
      />
    </GlassSurface>
  );
}

/** Conn turns large titles off: list tabs keep their title centred in the bar, a status line under it. */
function TasksTopBar(props: {
  readonly top: number;
  readonly title: string;
  readonly subtitle: string | null;
  readonly menu: ReactNode;
}) {
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 flex-row items-center px-4"
      style={{ top: props.top, height: BAR_HEIGHT }}
    >
      <View className="w-11" />
      <View pointerEvents="none" className="min-w-0 flex-1 items-center">
        <Text className="text-[17px] leading-5 font-t3-semibold text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-2xs tabular-nums text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      <View className="w-11 items-end">{props.menu}</View>
    </View>
  );
}
