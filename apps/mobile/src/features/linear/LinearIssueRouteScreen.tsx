import type { StaticScreenProps } from "@react-navigation/native";
import {
  activityStatusLabel,
  pickActivityPill,
  stepTone,
  type LinearStepTone,
} from "@t3tools/client-runtime/linear/activity";
import { formatProgressPercent } from "@t3tools/client-runtime/linear/issue-list";
import {
  EnvironmentId,
  ThreadId,
  type LinearActivityItem,
  type LinearComment,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearViewer,
} from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenWebLink } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useNavigateToPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { LinearActivityPill } from "./LinearIssueRow";
import {
  LinearAvatar,
  LinearGlyph,
  LinearMilestoneIcon,
  LinearPriorityIcon,
  LinearStateIcon,
  LinearTeamBadge,
} from "./linearIcons";
import { LinearBanner } from "./LinearPanels";
import { LinearScreen } from "./LinearScreen";
import type { LinearRouteParams } from "./linearRoutes";
import { useLinearLaunch, useOpenLinearThread } from "./useLinearLaunch";
import {
  useLinearActivity,
  useLinearAutoRefresh,
  useLinearDegradation,
  useLinearIssueDetail,
  useLinearRefresh,
  useLinearStatus,
} from "./useLinearData";
import { useLinearNavigation } from "./useLinearNavigation";

const TONE_CLASS: Record<LinearStepTone, string> = {
  ok: "bg-primary",
  running: "bg-primary opacity-60",
  failed: "bg-danger-foreground",
  idle: "bg-subtle-strong",
};

function SectionHeader(props: { readonly children: ReactNode; readonly count?: number }) {
  return (
    <View className="flex-row items-center gap-2 pb-2">
      <Text className="text-xs font-t3-bold tracking-wide text-foreground-muted uppercase">
        {props.children}
      </Text>
      {props.count === undefined ? null : (
        <Text className="text-xs tabular-nums text-foreground-muted">{props.count}</Text>
      )}
    </View>
  );
}

function Card(props: { readonly children: ReactNode }) {
  return (
    <View className="overflow-hidden rounded-[18px] border border-border bg-grouped-card">
      {props.children}
    </View>
  );
}

function MetaRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="min-h-9 flex-row items-center gap-3">
      <Text className="w-[84px] text-sm text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5">
        {props.children}
      </View>
    </View>
  );
}

function ActivityRow(props: {
  readonly item: LinearActivityItem;
  readonly onOpen: (item: LinearActivityItem) => void;
}) {
  const { item } = props;
  const pipeline = item.pipeline;
  const failed = item.status === "failed";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pipeline ? "Pipeline run" : "Chat"} ${pipeline?.name ?? item.title}, ${activityStatusLabel(item.status)}`}
      onPress={() => props.onOpen(item)}
      className="flex-row items-start gap-3 border-b border-border-subtle px-3.5 py-3 active:bg-row-hover"
    >
      <View className="pt-0.5">
        <SymbolView
          name={pipeline ? "point.3.connected.trianglepath.dotted" : "bubble.left"}
          size={16}
          tintColorClassName={failed ? "accent-danger-foreground" : "accent-icon-muted"}
        />
      </View>
      <View className="min-w-0 flex-1 gap-1.5">
        <Text className="text-base" numberOfLines={1}>
          {pipeline?.name ?? item.title}
        </Text>
        {pipeline ? (
          <View className="gap-1.5">
            <View className="flex-row gap-1">
              {pipeline.steps.map((step, index) => (
                <View
                  key={step.name + String(index)}
                  accessibilityLabel={`${step.name}: ${step.status}`}
                  className={cn("h-1 flex-1 rounded-full", TONE_CLASS[stepTone(step.status)])}
                />
              ))}
            </View>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {pipeline.failedStepName
                ? `${pipeline.failedStepName} failed`
                : (pipeline.currentStepName ?? item.title)}
            </Text>
          </View>
        ) : (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {[item.provider, item.messageCount === null ? null : `${item.messageCount} messages`]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        )}
      </View>
      <View className="items-end gap-0.5">
        <Text
          className={cn(
            "text-xs font-t3-medium",
            failed ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {activityStatusLabel(item.status)}
        </Text>
        <Text className="text-2xs tabular-nums text-foreground-tertiary">
          {relativeTime(item.updatedAt)}
        </Text>
      </View>
    </Pressable>
  );
}

function CommentRow(props: { readonly comment: LinearComment }) {
  const styles = useMarkdownPreviewStyles();
  const { comment } = props;
  return (
    <View className="flex-row gap-2.5">
      <LinearAvatar user={comment.author} size={22} />
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-baseline gap-1.5">
          <Text className="text-sm font-t3-medium">{comment.author?.name ?? "Linear"}</Text>
          <Text className="text-2xs text-foreground-muted">{relativeTime(comment.createdAt)}</Text>
        </View>
        <SelectableMarkdownText
          markdown={comment.body}
          textStyle={styles.nativeTextStyle}
          onLinkPress={(href) => void tryOpenWebLink(href, "markdown-link")}
        />
      </View>
    </View>
  );
}

function SubIssueRow(props: {
  readonly issue: LinearIssue;
  readonly onSelect: (issueId: string) => void;
}) {
  const { issue } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${issue.identifier}, ${issue.title}, ${issue.state.name}`}
      onPress={() => props.onSelect(issue.id)}
      className="min-h-11 flex-row items-center gap-2.5 border-b border-border-subtle px-3.5 active:bg-row-hover"
    >
      <LinearStateIcon type={issue.state.type} color={issue.state.color} size={16} />
      <Text className="font-mono text-xs text-foreground-muted">{issue.identifier}</Text>
      <Text className="min-w-0 flex-1 py-2.5 text-sm" numberOfLines={2}>
        {issue.title}
      </Text>
      <LinearAvatar user={issue.assignee} size={16} />
    </Pressable>
  );
}

function DetailBody(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: LinearIssueDetail;
  readonly viewer: LinearViewer | null;
}) {
  const { detail, viewer, environmentId } = props;
  const { issue } = detail;
  const linearNavigation = useLinearNavigation(environmentId, {});
  const launch = useLinearLaunch(environmentId);
  const openThread = useOpenLinearThread();
  const navigateToPullRequest = useNavigateToPullRequest();
  const activityQuery = useLinearActivity(environmentId);
  const markdownStyles = useMarkdownPreviewStyles();
  const [branchCopied, setBranchCopied] = useState(false);
  const activityLoaded = activityQuery.data !== null;
  const activity = activityQuery.byIssueId.get(issue.id);
  const pill = pickActivityPill(issue, activity);
  const items = activity?.items ?? [];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the "Copied" confirmation expires on a timer, cleared on unmount
  useEffect(() => {
    if (!branchCopied) return;
    const timeout = setTimeout(() => setBranchCopied(false), 1_600);
    return () => clearTimeout(timeout);
  }, [branchCopied]);
  const copyBranch = () => {
    copyTextWithHaptic(issue.branchName, { target: "branch name" });
    setBranchCopied(true);
  };
  // A pipeline run opens through its parent thread, like every other run entry point.
  const openActivity = (item: LinearActivityItem) =>
    openThread({ environmentId, threadId: ThreadId.make(item.link.threadId) });
  const openPullRequest = (url: string) => void navigateToPullRequest(url, { environmentId });
  return (
    <View className="gap-5 px-4 pt-3 pb-10">
      <View className="gap-1.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <LinearPriorityIcon priority={issue.priority} size={14} />
          <Text className="font-mono text-xs text-foreground-muted">{issue.identifier}</Text>
          <Text className="text-xs text-foreground-muted">
            · updated {relativeTime(issue.updatedAt)} ago
          </Text>
          {pill ? <LinearActivityPill pill={pill} /> : null}
        </View>
        <Text selectable className="text-xl leading-6 font-t3-bold">
          {issue.title}
        </Text>
        {issue.parent ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => linearNavigation.openIssue(issue.parent!.id)}
            className="min-h-11 justify-center self-start active:opacity-60"
          >
            <Text className="text-xs text-foreground-muted">
              Sub-issue of {issue.parent.identifier}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View className="flex-row flex-wrap items-center gap-2">
        <Menu
          shouldOpenOnLongPress
          title="Start chat"
          actions={[
            { id: "worktree", title: "New worktree" },
            { id: "local", title: "Local checkout" },
          ]}
          onPressAction={({ nativeEvent }) =>
            launch.startChat(issue.id, {
              workspace: nativeEvent.event === "local" ? "local" : "worktree",
            })
          }
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start chat"
            accessibilityHint="Touch and hold to choose a new worktree or the local checkout."
            accessibilityState={{ disabled: launch.startingChat, busy: launch.startingChat }}
            disabled={launch.startingChat}
            onPress={() => launch.startChat(issue.id)}
            className={cn(
              "min-h-12 flex-row items-center gap-2 rounded-full bg-primary px-6 active:opacity-70",
              launch.startingChat && "opacity-70",
            )}
          >
            {launch.startingChat ? (
              <AppActivityIndicator size="small" colorClassName="accent-primary-foreground" />
            ) : (
              <SymbolView
                name="bubble.left"
                size={18}
                tintColorClassName="accent-primary-foreground"
              />
            )}
            <Text className="font-t3-medium text-primary-foreground">Start chat</Text>
          </Pressable>
        </Menu>
        <Button
          label="Run pipeline"
          icon="point.3.connected.trianglepath.dotted"
          disabled={!launch.canRunPipeline}
          onPress={() => launch.openPipeline(issue.id)}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy branch name ${issue.branchName}`}
        onPress={copyBranch}
        className="flex-row items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 active:opacity-70"
      >
        <SymbolView name="arrow.branch" size={14} tintColorClassName="accent-icon-muted" />
        <Text
          selectable
          className="min-w-0 flex-1 font-mono text-xs text-foreground-secondary"
          numberOfLines={1}
        >
          {issue.branchName}
        </Text>
        <SymbolView
          name={branchCopied ? "checkmark.circle" : "doc.on.doc"}
          size={15}
          tintColorClassName="accent-icon-muted"
        />
        <Text className="text-xs text-foreground-muted">{branchCopied ? "Copied" : "Copy"}</Text>
      </Pressable>

      <View>
        <MetaRow label="State">
          <LinearStateIcon type={issue.state.type} color={issue.state.color} size={15} />
          <Text className="text-sm">{issue.state.name}</Text>
        </MetaRow>
        <MetaRow label="Priority">
          <LinearPriorityIcon priority={issue.priority} size={15} />
          <Text className="text-sm">{issue.priorityLabel}</Text>
        </MetaRow>
        <MetaRow label="Assignee">
          <LinearAvatar user={issue.assignee} size={18} />
          <Text className="text-sm">{issue.assignee?.name ?? "Unassigned"}</Text>
          {issue.assignee !== null && issue.assignee.id === viewer?.id ? (
            <Text className="text-sm text-foreground-muted">(you)</Text>
          ) : null}
        </MetaRow>
        {issue.project ? (
          <MetaRow label="Project">
            <Text className="text-sm">{issue.project.name}</Text>
          </MetaRow>
        ) : null}
        {issue.milestone ? (
          <MetaRow label="Milestone">
            <LinearMilestoneIcon progress={detail.milestoneProgress ?? 0} />
            <Text className="text-sm">{issue.milestone.name}</Text>
            {detail.milestoneProgress === null ? null : (
              <Text className="text-xs tabular-nums text-foreground-muted">
                {formatProgressPercent(detail.milestoneProgress)}%
              </Text>
            )}
          </MetaRow>
        ) : null}
        {issue.cycle ? (
          <MetaRow label="Cycle">
            <Text className="text-sm">Cycle {issue.cycle.number}</Text>
          </MetaRow>
        ) : null}
        {issue.labels.length > 0 ? (
          <MetaRow label="Labels">
            {issue.labels.map((label) => (
              <View
                key={label.id}
                className="flex-row items-center gap-1 rounded-full border border-border px-2 py-0.5"
              >
                <View
                  style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: label.color }}
                />
                <Text className="text-xs text-foreground-muted">{label.name}</Text>
              </View>
            ))}
          </MetaRow>
        ) : null}
      </View>

      {detail.description.trim() === "" ? null : (
        <View>
          <SectionHeader>Description</SectionHeader>
          <SelectableMarkdownText
            markdown={detail.description}
            textStyle={markdownStyles.nativeTextStyle}
            onLinkPress={(href) => void tryOpenWebLink(href, "markdown-link")}
          />
        </View>
      )}

      {detail.subIssues.length > 0 ? (
        <View>
          <SectionHeader count={detail.subIssues.length}>Sub-issues</SectionHeader>
          <Card>
            {detail.subIssues.map((subIssue) => (
              <SubIssueRow
                key={subIssue.id}
                issue={subIssue}
                onSelect={linearNavigation.openIssue}
              />
            ))}
          </Card>
        </View>
      ) : detail.subIssuesFailed ? (
        <View>
          <SectionHeader>Sub-issues</SectionHeader>
          <Text className="text-xs text-foreground-muted">Couldn't load sub-issues.</Text>
        </View>
      ) : null}

      {issue.linkedPullRequests.length > 0 ? (
        <View>
          <SectionHeader count={issue.linkedPullRequests.length}>
            Linked pull requests
          </SectionHeader>
          <Card>
            {issue.linkedPullRequests.map((pullRequest) => (
              <Pressable
                key={pullRequest.url}
                accessibilityRole="button"
                accessibilityLabel={`Pull request ${pullRequest.repository ?? ""} ${pullRequest.number}${pullRequest.state ? `, ${pullRequest.state.toLowerCase()}` : ""}`}
                onPress={() => openPullRequest(pullRequest.url)}
                className="min-h-11 flex-row items-center gap-2.5 border-b border-border-subtle px-3.5 active:bg-row-hover"
              >
                <SymbolView
                  name={PullRequestGlyph.pullRequest}
                  size={16}
                  tintColorClassName={
                    pullRequest.state?.toLowerCase() === "open"
                      ? "accent-adaptive-emerald-600-400"
                      : "accent-icon-muted"
                  }
                />
                <Text className="min-w-0 flex-1 py-2.5 text-sm" numberOfLines={1}>
                  {pullRequest.repository ? `${pullRequest.repository} ` : ""}#{pullRequest.number}
                </Text>
                {pullRequest.state ? (
                  <Text className="text-xs text-foreground-muted capitalize">
                    {pullRequest.state.toLowerCase()}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </Card>
        </View>
      ) : null}

      <View>
        <SectionHeader count={activityLoaded ? items.length : undefined}>T3 activity</SectionHeader>
        {!activityLoaded ? (
          activityQuery.error === null ? (
            <View className="h-12 rounded-[18px] bg-subtle-strong" />
          ) : (
            <Text className="text-xs text-foreground-muted">Couldn't load T3 activity.</Text>
          )
        ) : items.length === 0 ? (
          <Text className="text-xs text-foreground-muted">
            No chats or pipeline runs started from this issue yet.
          </Text>
        ) : (
          <Card>
            {items.map((item) => (
              <ActivityRow key={item.link.linkId} item={item} onOpen={openActivity} />
            ))}
          </Card>
        )}
      </View>

      {detail.comments.length > 0 ? (
        <View className="gap-3">
          <SectionHeader count={detail.comments.length}>Recent comments</SectionHeader>
          {detail.comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} />
          ))}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="link"
        onPress={() => void tryOpenWebLink(issue.url, "markdown-link")}
        className="min-h-11 flex-row items-center gap-1.5 self-start active:opacity-60"
      >
        <LinearGlyph size={12} />
        <Text className="text-xs text-foreground-muted">Open in Linear</Text>
      </Pressable>
    </View>
  );
}

function IssueSkeleton() {
  return (
    <View
      className="gap-3 px-4 py-4"
      accessibilityLabel="Loading issue"
      accessibilityState={{ busy: true }}
    >
      <View className="h-3 w-24 rounded bg-subtle-strong" />
      <View className="h-6 w-4/5 rounded bg-subtle-strong" />
      <View className="h-12 w-48 rounded-full bg-subtle-strong" />
      <View className="h-32 w-full rounded-[18px] bg-subtle-strong" />
    </View>
  );
}

export function LinearIssueRouteScreen({
  route,
}: StaticScreenProps<LinearRouteParams["LinearIssue"]>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const { issueId } = route.params;
  const insets = useSafeAreaInsets();
  const status = useLinearStatus(environmentId);
  const query = useLinearIssueDetail(environmentId, issueId);
  const { refresh, refreshing } = useLinearRefresh(environmentId);
  // DetailBody reads the same activity query; polling it here covers the whole page.
  const activity = useLinearActivity(environmentId);
  useLinearAutoRefresh(true, [status, query, activity]);
  const degradation = useLinearDegradation(environmentId, [query.failure], false);
  // The issue switched but its answer has not landed: never show the previous issue's body.
  const detail = query.data?.issue.id === issueId ? query.data : null;
  const issue = detail?.issue;
  const team = status.data?.teams.find((entry) => entry.id === issue?.team.id);
  return (
    <LinearScreen
      title={issue?.identifier ?? "Issue"}
      subtitle={
        issue
          ? `${issue.team.name}${issue.milestone ? ` › ${issue.milestone.name}` : ""}`
          : undefined
      }
      menus={
        issue
          ? [
              {
                title: "Issue options",
                icon: "ellipsis.circle",
                items: [
                  {
                    id: "open",
                    title: "Open in Linear",
                    onPress: () => void tryOpenWebLink(issue.url, "markdown-link"),
                  },
                  {
                    id: "branch",
                    title: "Copy branch name",
                    onPress: () => copyTextWithHaptic(issue.branchName, { target: "branch name" }),
                  },
                  {
                    id: "link",
                    title: "Copy issue link",
                    onPress: () => copyTextWithHaptic(issue.url, { target: "issue link" }),
                  },
                  {
                    id: "identifier",
                    title: "Copy identifier",
                    onPress: () => copyTextWithHaptic(issue.identifier, { target: "identifier" }),
                  },
                ],
              },
            ]
          : undefined
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {degradation ? (
          <LinearBanner degradation={degradation} onRetry={refresh} retrying={refreshing} />
        ) : null}
        {issue && team ? (
          <View className="flex-row px-4 pt-2">
            <LinearTeamBadge teamKey={issue.team.key} color={team.color} />
          </View>
        ) : null}
        {detail ? (
          <DetailBody
            environmentId={environmentId}
            detail={detail}
            viewer={status.data?.viewer ?? null}
          />
        ) : query.error !== null ? (
          <View className="items-center gap-3 px-8 py-12">
            <Text className="text-center text-sm text-foreground-muted">
              Couldn't load this issue.
            </Text>
            <Button label="Retry" onPress={query.refresh} />
          </View>
        ) : (
          <IssueSkeleton />
        )}
      </ScrollView>
    </LinearScreen>
  );
}
