import { orbitTaskLane, type OrbitTaskSummary } from "@t3tools/client-runtime/orbit-gateway";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { useGT, useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { WithStatusBadgeDot } from "../../components/StatusBadgeDot";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  ROW_TONE_TEXT,
  ROW_TONE_TINT,
  orbitAgentProvider,
  taskDotState,
  taskStatusRow,
  type DotTone,
  type RowStatus,
} from "./taskPresentation";

/** Every Tasks list row: inset 8pt from the edge, 12pt corners, highlighted only while pressed. */
export function TaskListRow(props: {
  readonly lead: ReactNode;
  readonly title: ReactNode;
  /** Work in progress drops to regular weight, like a working thread. */
  readonly recede?: boolean;
  readonly muted?: boolean;
  readonly trailing?: ReactNode;
  readonly detail?: ReactNode;
  readonly detailTrailing?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : undefined}
      accessibilityLabel={props.accessibilityLabel}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="mx-2"
    >
      {({ pressed }) => (
        <View className={cn("rounded-xl px-2 py-2.5", pressed && "bg-row-hover")}>
          <View className="flex-row items-start gap-2">
            <View className="h-[23px] w-5 items-start justify-center">{props.lead}</View>
            <Text
              className={cn(
                "min-w-0 flex-1 text-base",
                props.muted ? "text-foreground-muted" : "text-foreground",
                !props.recede && !props.muted && "font-t3-medium",
              )}
              numberOfLines={2}
            >
              {props.title}
            </Text>
            {props.trailing ? (
              <View className="h-[23px] justify-center">{props.trailing}</View>
            ) : null}
          </View>
          {props.detail || props.detailTrailing ? (
            <View className="mt-1 flex-row items-center gap-2 pl-7">
              <Text
                className="min-w-0 flex-1 text-[13px] leading-5 text-foreground-tertiary"
                numberOfLines={1}
              >
                {props.detail}
              </Text>
              {props.detailTrailing}
            </View>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

/** A row's coloured status: icon, then a label or a timer, medium weight like the label beside it. */
export function RowStatusView(props: { readonly status: RowStatus }) {
  const m = useMessages();
  const { status } = props;
  const text = [
    status.label === null ? null : m(status.label),
    status.timerMs === null ? null : formatWorkingDurationLabel(status.timerMs, m),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <View className="flex-row items-center gap-1">
      <SymbolView
        name={status.icon}
        size={13}
        type="monochrome"
        weight="semibold"
        tintColorClassName={ROW_TONE_TINT[status.tone]}
      />
      {text ? (
        <Text className={cn("text-sm font-t3-medium tabular-nums", ROW_TONE_TEXT[status.tone])}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

export function QuietValue(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Text className={cn("text-sm tabular-nums text-foreground-tertiary", props.className)}>
      {props.children}
    </Text>
  );
}

/** Lines added and removed, or a dash when Orbit did not report them. */
export function DiffStat(props: {
  readonly added: number | null;
  readonly deleted: number | null;
  readonly className?: string;
}) {
  if (props.added === null || props.deleted === null)
    return <QuietValue className={cn("opacity-60", props.className)}>–</QuietValue>;
  return (
    <View className="flex-row items-center gap-1">
      <Text className={cn("text-sm tabular-nums text-adaptive-emerald-600-400", props.className)}>
        +{props.added.toLocaleString()}
      </Text>
      <Text className={cn("text-sm tabular-nums text-danger-foreground", props.className)}>
        −{props.deleted.toLocaleString()}
      </Text>
    </View>
  );
}

const PROJECT_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#ef4444",
];

/** Orbit projects carry no favicon, so a task row shows a lettered tile in a stable colour. */
export function ProjectTile(props: { readonly name: string }) {
  const hash = [...props.name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center"
      style={{
        width: 18,
        height: 18,
        borderRadius: 5,
        backgroundColor: PROJECT_COLORS[hash % PROJECT_COLORS.length],
      }}
    >
      <Text className="font-t3-bold text-white" style={{ fontSize: 10, lineHeight: 13 }}>
        {(props.name[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * A task as a list row: the project badge (status dot on its corner) and the title on line 1;
 * project, #id, subtasks, time, node and the PR under the title. On the Tasks tab it sits on the
 * screen; as a card in a thread (`card`) the frame comes from the caller and the dot's ring
 * takes the card's fill.
 */
export function TaskRow(props: {
  readonly task: OrbitTaskSummary;
  readonly durationMs: number | null;
  readonly now: number;
  readonly onPress: () => void;
  readonly card?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const { task } = props;
  const { total, completed } = task.subtaskCounts;
  const dotState = taskDotState(task);
  const inProgress = orbitTaskLane(task.status) === "in-progress";
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
  const time =
    inProgress && props.durationMs !== null
      ? formatWorkingDurationLabel(props.durationMs, m)
      : relativeTime(task.lastActivityAt ?? task.updatedAt, props.now, m);
  const detail = [
    task.project.name.toLowerCase(),
    `#${task.id}`,
    total > 0 ? `${completed}/${total}` : null,
    time,
    task.workspace?.node?.name ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const recede = dotState === "working";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        task.title,
        m(taskStatusRow(task).label),
        `#${task.id}`,
        detail,
        pr ? gt("Pull request {number}", { number: pr.number }) : null,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={props.onPress}
      style={props.card ? undefined : { marginHorizontal: 8, marginBottom: 4 }}
    >
      {({ pressed }) => (
        <View
          className={cn(pressed && (props.card ? "bg-foreground/5" : "bg-row-hover"))}
          style={{
            rowGap: 6,
            borderRadius: props.card ? 0 : 12,
            paddingTop: 12,
            paddingRight: props.card ? 12 : 8,
            paddingBottom: 12,
            paddingLeft: props.card ? 12 : 4,
          }}
        >
          <View className="flex-row items-start" style={{ columnGap: 12, minHeight: 23 }}>
            <View className="shrink-0" style={{ marginTop: 2.5 }}>
              <WithStatusBadgeDot
                state={dotState}
                ringClassName={props.card ? "bg-card-face" : "bg-screen"}
              >
                {props.card ? (
                  <View className="items-center justify-center" style={{ width: 18, height: 18 }}>
                    <SymbolView name="checklist" size={16} tintColorClassName="accent-icon-muted" />
                  </View>
                ) : (
                  <ProjectTile name={task.project.name} />
                )}
              </WithStatusBadgeDot>
            </View>
            <Text
              className={cn(
                "min-w-0 flex-1 text-base text-foreground",
                !recede && "font-t3-medium",
              )}
              numberOfLines={props.card ? 2 : 1}
            >
              {task.title}
            </Text>
          </View>
          <View className="flex-row items-center" style={{ paddingLeft: 30 }}>
            <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
              {detail}
              {pr ? " · " : null}
            </Text>
            {pr ? (
              <View className="shrink-0 flex-row items-center gap-[3px]">
                <SymbolView
                  name={
                    pr.state === "merged" ? PullRequestGlyph.merged : PullRequestGlyph.pullRequest
                  }
                  size={12}
                  type="monochrome"
                  tintColorClassName={prTint}
                />
                <Text className={cn("text-xs tabular-nums", prTone)}>#{pr.number}</Text>
              </View>
            ) : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}

const DOT_CLASS: Readonly<Record<DotTone, string>> = {
  success: "bg-adaptive-emerald-600-400",
  info: "bg-adaptive-sky-600-400",
  warning: "bg-warning-foreground",
  destructive: "bg-adaptive-rose-600-400",
  muted: "bg-foreground-muted",
};

/** An agent's model icon with a status dot at its corner. */
export function AgentGlyph(props: {
  readonly provider: string | null;
  readonly dot: DotTone;
  readonly size?: number;
}) {
  const size = props.size ?? 16;
  return (
    <View style={{ width: size, height: size }}>
      <ProviderIcon provider={orbitAgentProvider(props.provider)} size={size} />
      <View
        className={cn(
          "absolute h-2 w-2 rounded-full border-[1.5px] border-screen",
          DOT_CLASS[props.dot],
        )}
        style={{ right: -3, bottom: -3 }}
      />
    </View>
  );
}

export function StateGlyph(props: {
  readonly name: AppSymbolName;
  readonly tintClassName: string;
  readonly size?: number;
  readonly faded?: boolean;
}) {
  return (
    <View className={props.faded ? "opacity-40" : undefined}>
      <SymbolView
        name={props.name}
        size={props.size ?? 16}
        type="monochrome"
        weight="medium"
        tintColorClassName={props.tintClassName}
      />
    </View>
  );
}

/** A second-level heading on detail screens, smaller than the title. */
export function SectionHeading(props: { readonly title: string; readonly meta?: string }) {
  return (
    <View className="mt-7 mb-5 flex-row items-center gap-2.5 px-4">
      <Text className="flex-1 text-[19px] leading-6 font-t3-medium text-foreground">
        {props.title}
      </Text>
      {props.meta ? <QuietValue>{props.meta}</QuietValue> : null}
    </View>
  );
}

/** A fact about the item: icon, one line, a quiet value. A row that leads somewhere gets a chevron. */
export function InfoRow(props: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly multiline?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : undefined}
      accessibilityLabel={props.accessibilityLabel}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="mx-2"
    >
      {({ pressed }) => (
        <View
          style={{ minHeight: 44 }}
          className={cn(
            "flex-row items-center gap-2 rounded-xl px-2",
            props.multiline && "py-2.5",
            pressed && "bg-row-hover",
          )}
        >
          <View className="w-5 items-start">{props.icon}</View>
          <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
            {typeof props.children === "string" ? (
              <Text
                className="min-w-0 flex-1 text-[15px] text-foreground"
                numberOfLines={props.multiline ? undefined : 1}
              >
                {props.children}
              </Text>
            ) : (
              props.children
            )}
          </View>
          {props.trailing}
          {props.onPress ? (
            <SymbolView
              name="chevron.right"
              size={13}
              type="monochrome"
              weight="semibold"
              tintColorClassName="accent-foreground-tertiary"
            />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

export function EmptyLine(props: { readonly children: ReactNode }) {
  return <Text className="px-4 py-3 text-[15px] text-foreground-muted">{props.children}</Text>;
}
