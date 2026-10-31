import {
  formatLinearIssueCount,
  formatProgressPercent,
} from "@t3tools/client-runtime/linear/issue-list";
import { formatLinearTargetDate } from "@t3tools/client-runtime/linear/jump";
import type {
  LinearMilestone,
  LinearProject,
  LinearStateType,
  LinearTeam,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import {
  LinearMilestoneIcon,
  LinearProgressBar,
  LinearStateIcon,
  LinearTeamBadge,
} from "./linearIcons";

export function LinearTeamCard(props: {
  readonly team: LinearTeam;
  readonly running: number;
  readonly onOpen: (teamId: string) => void;
}) {
  const { team, running } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${team.name}, ${team.projectCount} projects, ${team.assignedToViewerCount} assigned to you${running > 0 ? `, ${running} running` : ""}`}
      onPress={() => props.onOpen(team.id)}
      className="mx-4 mb-2.5 gap-2 rounded-[18px] border border-border bg-card p-3.5 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <LinearTeamBadge teamKey={team.key} color={team.color} />
        <Text className="min-w-0 flex-1 text-base font-t3-bold" numberOfLines={1}>
          {team.name}
        </Text>
        <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      </View>
      {team.description ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {team.description}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-x-3.5 gap-y-1">
        <Text className="text-2xs text-foreground-muted">
          <Text className="text-2xs font-t3-medium tabular-nums text-foreground">
            {team.projectCount}
          </Text>{" "}
          {team.projectCount === 1 ? "project" : "projects"}
        </Text>
        <Text className="text-2xs text-foreground-muted">
          <Text className="text-2xs font-t3-medium tabular-nums text-foreground">
            {team.assignedToViewerCount}
          </Text>{" "}
          assigned to you
        </Text>
        {running > 0 ? (
          <View className="flex-row items-center gap-1 rounded-full border border-border bg-subtle px-1.5 py-px">
            <View className="size-1.5 rounded-full bg-primary" />
            <Text className="text-2xs text-primary-text">
              <Text className="text-2xs tabular-nums text-primary-text">{running}</Text> running
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function LinearProjectRow(props: {
  readonly project: LinearProject;
  readonly onOpen: (projectId: string) => void;
}) {
  const { project } = props;
  const target = formatLinearTargetDate(project.targetDate);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${project.name}, ${project.status.name}, ${formatProgressPercent(project.progress)} percent${target ? `, target ${target}` : ""}`}
      onPress={() => props.onOpen(project.id)}
      className="min-h-14 flex-row items-center gap-3 px-4 active:bg-row-hover"
    >
      <View
        className="size-2.5 rounded-full bg-foreground-muted"
        style={project.status.color ? { backgroundColor: project.status.color } : undefined}
      />
      <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5">
        <Text className="text-base font-t3-medium" numberOfLines={1}>
          {project.name}
        </Text>
        <View className="flex-row items-center gap-2">
          <LinearProgressBar progress={project.progress} />
          <Text className="text-2xs tabular-nums text-foreground-muted">
            {formatProgressPercent(project.progress)}%
          </Text>
          <Text className="min-w-0 shrink text-2xs text-foreground-muted" numberOfLines={1}>
            {[project.status.name, target].filter(Boolean).join(" · ")}
          </Text>
        </View>
      </View>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

export function LinearMilestoneRow(props: {
  readonly milestone: LinearMilestone;
  readonly onOpen: (milestoneId: string) => void;
}) {
  const { milestone } = props;
  const target = formatLinearTargetDate(milestone.targetDate);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${milestone.name}, ${formatProgressPercent(milestone.progress)} percent, ${formatLinearIssueCount(milestone.issueCount, milestone.issueCountCapped)}${target ? `, target ${target}` : ""}`}
      onPress={() => props.onOpen(milestone.id)}
      className="min-h-14 flex-row items-center gap-3 px-4 active:bg-row-hover"
    >
      <LinearMilestoneIcon progress={milestone.progress} />
      <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5">
        <Text
          className={cn(
            "text-base",
            milestone.completed ? "text-foreground-muted" : "font-t3-medium",
          )}
          numberOfLines={1}
        >
          {milestone.name}
        </Text>
        <View className="flex-row items-center gap-2">
          <LinearProgressBar progress={milestone.progress} />
          <Text className="text-2xs tabular-nums text-foreground-muted">
            {formatProgressPercent(milestone.progress)}%
          </Text>
          <Text className="min-w-0 shrink text-2xs text-foreground-muted" numberOfLines={1}>
            {[formatLinearIssueCount(milestone.issueCount, milestone.issueCountCapped), target]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      </View>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

export function LinearNoMilestoneRow(props: { readonly onOpen: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="No milestone"
      onPress={props.onOpen}
      className="min-h-12 flex-row items-center gap-3 px-4 active:bg-row-hover"
    >
      <View className="opacity-50">
        <LinearMilestoneIcon progress={0} />
      </View>
      <Text className="min-w-0 flex-1 text-base text-foreground-muted" numberOfLines={1}>
        No milestone
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

export function LinearProgressSummary(props: {
  readonly progress: number;
  readonly issueCount: number;
  readonly issueCountCapped: boolean;
  readonly targetDate: string | null;
}) {
  const target = formatLinearTargetDate(props.targetDate);
  return (
    <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
      <LinearProgressBar progress={props.progress} width={96} />
      <Text className="text-xs tabular-nums text-foreground-muted">
        {formatProgressPercent(props.progress)}%
      </Text>
      <Text className="text-xs tabular-nums text-foreground-muted">
        · {formatLinearIssueCount(props.issueCount, props.issueCountCapped)}
      </Text>
      {target ? <Text className="text-xs text-foreground-muted">· Target {target}</Text> : null}
    </View>
  );
}

export function LinearGroupHeader(props: {
  readonly label: string;
  readonly count: number;
  readonly stateType: LinearStateType | null;
  readonly stateColor: string | undefined;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.count} issues`}
      accessibilityState={{ expanded: !props.collapsed }}
      onPress={props.onToggle}
      className="h-9 flex-row items-center gap-2 bg-subtle px-4 active:opacity-70"
    >
      <SymbolView
        name={props.collapsed ? "chevron.right" : "chevron.down"}
        size={10}
        tintColorClassName="accent-icon-muted"
      />
      {props.stateType === null ? null : (
        <LinearStateIcon type={props.stateType} color={props.stateColor} size={13} />
      )}
      <Text className="text-sm font-t3-medium text-foreground-secondary">{props.label}</Text>
      <Text className="text-sm tabular-nums text-foreground-muted">{props.count}</Text>
    </Pressable>
  );
}
