import {
  pickActivityPill,
  type LinearActivityPill as ActivityPill,
} from "@t3tools/client-runtime/linear/activity";
import type { EnvironmentId, LinearIssue, LinearIssueActivity } from "@t3tools/contracts";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { LinearAvatar, LinearPriorityIcon, LinearStateIcon } from "./linearIcons";
import { useLinearSubIssues } from "./useLinearData";

const PILL_CLASS: Record<ActivityPill["kind"], { container: string; text: string }> = {
  "pipeline-failed": {
    container: "border-danger-border bg-danger",
    text: "text-danger-foreground",
  },
  "pipeline-running": { container: "border-border bg-subtle", text: "text-primary-text" },
  "pr-opened": { container: "border-border bg-subtle", text: "text-foreground-secondary" },
  chats: { container: "border-border bg-subtle", text: "text-foreground-muted" },
};

/** The one T3 activity pill an issue row shows (see `pickActivityPill` for precedence). */
export function LinearActivityPill(props: { readonly pill: ActivityPill }) {
  const { pill } = props;
  const style = PILL_CLASS[pill.kind];
  return (
    <View
      accessibilityLabel={`T3 ${pill.label}${pill.chatCount > 0 ? `, ${pill.chatCount} chats` : ""}`}
      className={cn(
        "flex-row items-center gap-1 rounded-full border px-1.5 py-px",
        style.container,
      )}
    >
      <Text className={cn("text-3xs font-t3-bold", style.text)}>T3</Text>
      <Text className={cn("text-2xs font-t3-medium", style.text)} numberOfLines={1}>
        {pill.label}
      </Text>
      {pill.chatCount > 0 ? (
        <Text className={cn("text-2xs tabular-nums", style.text)}>· {pill.chatCount}</Text>
      ) : null}
    </View>
  );
}

function LinearLabelChip(props: { readonly name: string; readonly color: string }) {
  return (
    <View className="max-w-[140px] shrink flex-row items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5">
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: props.color }} />
      <Text className="shrink text-2xs font-t3-medium text-foreground-muted" numberOfLines={1}>
        {props.name}
      </Text>
    </View>
  );
}

export interface LinearIssueRowContext {
  readonly environmentId: EnvironmentId | null;
  readonly activityByIssueId: ReadonlyMap<string, LinearIssueActivity>;
  readonly onSelect: (issueId: string) => void;
  /** Kept by the screen: recycled list rows must not carry another issue's expansion. */
  readonly expandedIds: ReadonlySet<string>;
  readonly onToggleExpanded: (issueId: string) => void;
}

/** Which issue rows show their sub-issues, for one screen's list. */
export function useLinearExpandedIssues() {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const onToggleExpanded = (issueId: string) =>
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(issueId)) next.add(issueId);
      return next;
    });
  return { expandedIds, onToggleExpanded };
}

function LinearSubIssueTree(props: {
  readonly issueId: string;
  readonly depth: number;
  readonly context: LinearIssueRowContext;
}) {
  const { depth, context } = props;
  const subIssues = useLinearSubIssues(context.environmentId, props.issueId);
  return (
    <View>
      {(subIssues.data ?? []).map((child) => (
        <LinearIssueRow key={child.id} issue={child} depth={depth} context={context} />
      ))}
      {subIssues.data === null && subIssues.error === null ? (
        <Text
          className="py-2 text-xs text-foreground-muted"
          style={{ paddingLeft: 56 + depth * 20 }}
        >
          Loading sub-issues…
        </Text>
      ) : null}
      {subIssues.data === null && subIssues.error !== null ? (
        <Pressable
          accessibilityRole="button"
          onPress={subIssues.refresh}
          style={{ paddingLeft: 56 + depth * 20 }}
          className="min-h-11 justify-center"
        >
          <Text className="text-xs text-foreground-muted">Couldn't load sub-issues. Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const LinearIssueRow = memo(function LinearIssueRowView(props: {
  readonly issue: LinearIssue;
  readonly depth?: number;
  readonly context: LinearIssueRowContext;
}) {
  const { issue, context } = props;
  const depth = props.depth ?? 0;
  const pill = pickActivityPill(issue, context.activityByIssueId.get(issue.id));
  const pullRequest = issue.linkedPullRequests[0];
  const finished = issue.state.type === "completed" || issue.state.type === "canceled";
  const hasChildren = issue.subIssueCount > 0;
  const expanded = hasChildren && context.expandedIds.has(issue.id);
  return (
    <View>
      <View className="flex-row" style={{ paddingLeft: depth * 20 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${issue.identifier}, ${issue.title}, ${issue.state.name}, ${issue.priorityLabel}${issue.assignee ? `, assigned to ${issue.assignee.name}` : ""}${pill ? `, ${pill.label}` : ""}`}
          accessibilityHint="Double tap to open."
          onPress={() => context.onSelect(issue.id)}
          className="min-w-0 flex-1 flex-row gap-3 px-4 active:bg-row-hover"
        >
          <View className="self-start pt-3">
            <LinearStateIcon type={issue.state.type} color={issue.state.color} size={18} />
          </View>
          <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5">
            <View className="flex-row items-center gap-1.5">
              <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
                {issue.identifier}
              </Text>
              <View className="flex-1" />
              {pill ? <LinearActivityPill pill={pill} /> : null}
              <Text className="text-2xs tabular-nums text-foreground-tertiary">
                {relativeTime(issue.updatedAt)}
              </Text>
            </View>
            <Text
              className={cn(
                "text-base leading-5 font-t3-medium",
                finished ? "text-foreground-muted" : "text-foreground",
              )}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {issue.title}
            </Text>
            <View className="flex-row items-center gap-2">
              <LinearPriorityIcon priority={issue.priority} size={13} />
              {hasChildren ? (
                <Text className="text-2xs tabular-nums text-foreground-muted">
                  ↳ {issue.completedSubIssueCount}/{issue.subIssueCount}
                </Text>
              ) : null}
              <View className="min-w-0 flex-1 flex-row items-center gap-1">
                {issue.labels.slice(0, 2).map((label) => (
                  <LinearLabelChip key={label.id} name={label.name} color={label.color} />
                ))}
                {issue.labels.length > 2 ? (
                  <Text className="shrink-0 text-2xs text-foreground-tertiary">
                    +{issue.labels.length - 2}
                  </Text>
                ) : null}
              </View>
              {pullRequest ? (
                <View className="flex-row items-center gap-0.5">
                  <SymbolView
                    name={PullRequestGlyph.pullRequest}
                    size={12}
                    tintColorClassName="accent-icon-muted"
                  />
                  <Text className="text-2xs tabular-nums text-foreground-muted">
                    #{pullRequest.number}
                  </Text>
                </View>
              ) : null}
              <LinearAvatar user={issue.assignee} size={16} />
            </View>
          </View>
        </Pressable>
        {hasChildren ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Collapse sub-issues" : "Expand sub-issues"}
            accessibilityState={{ expanded }}
            onPress={() => context.onToggleExpanded(issue.id)}
            hitSlop={4}
            className="w-9 items-center pt-3 active:opacity-60"
          >
            <SymbolView
              name={expanded ? "chevron.up" : "chevron.down"}
              size={12}
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <LinearSubIssueTree issueId={issue.id} depth={depth + 1} context={context} />
      ) : null}
    </View>
  );
});
