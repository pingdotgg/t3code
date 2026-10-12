import { PullRequestEntryRow } from "./PullRequestEntryRow";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import IconGitCommit from "@tabler/icons-react-native/IconGitCommit";
import type { PullRequestActivity, PullRequestComment } from "@t3tools/contracts";
import { StackActions, type NavigationProp } from "@react-navigation/native";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { parseMarkdownDocument } from "../../lib/markdownDocument";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { relativeTime } from "../../lib/time";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";
import type { PullRequestParams } from "./usePullRequestDiff";

function TimelineEvent(props: {
  icon: AppSymbolName | "commit";
  tone?: "success" | "danger";
  children: ReactNode;
}) {
  const { themeVariables: colors } = useAppearancePreferences();
  return (
    <PullRequestEntryRow
      leading={
        <>
          <View className="absolute top-0 bottom-0 w-px bg-border-subtle" />
          <View className="size-8 items-center justify-center rounded-full border border-border-subtle bg-grouped-card">
            {props.icon === "commit" ? (
              <View style={{ transform: [{ rotate: "90deg" }] }}>
                <IconGitCommit
                  size={17}
                  color={colors["--color-foreground-muted"] ?? "#838383"}
                  strokeWidth={1.8}
                />
              </View>
            ) : (
              <SymbolView
                name={props.icon}
                size={15}
                tintColorClassName={
                  props.tone === "success"
                    ? "accent-adaptive-emerald-600-400"
                    : props.tone === "danger"
                      ? "accent-danger-foreground"
                      : "accent-icon-muted"
                }
              />
            )}
          </View>
        </>
      }
    >
      <View className="gap-2 pt-1 pb-6">{props.children}</View>
    </PullRequestEntryRow>
  );
}

function TimelineComment({ comment }: { comment: PullRequestComment }) {
  const [expanded, setExpanded] = useState(false);
  const { themeVariables: colors } = useAppearancePreferences();
  const long = comment.body.length > 450 || comment.body.split("\n").length > 8;
  const content = useMemo(
    () => pullRequestDescriptionContent(parseMarkdownDocument(comment.body)),
    [comment.body],
  );
  const preview = content.preview;
  const approved = comment.reviewState === "APPROVED";
  const changes = comment.reviewState === "CHANGES_REQUESTED";
  return (
    <TimelineEvent
      icon={approved ? "checkmark" : changes ? "doc.text" : "text.bubble"}
      tone={approved ? "success" : changes ? "danger" : undefined}
    >
      <View className="flex-row items-center gap-2">
        <PullRequestAvatar actor={comment.author} size={22} />
        <View className="min-w-0 flex-1">
          <Text className="text-sm">
            <Text className="font-t3-medium">{comment.author?.login ?? "Unknown author"}</Text>
            <Text className="text-foreground-muted">
              {approved ? " approved" : changes ? " requested changes" : " commented"}
            </Text>
          </Text>
        </View>
        <Text className="text-2xs text-foreground-tertiary">{relativeTime(comment.createdAt)}</Text>
      </View>
      {comment.path ? (
        <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={2}>
          {comment.path}
        </Text>
      ) : null}
      {preview.trim() || content.attachments.length ? (
        <View className="gap-2 overflow-hidden rounded-2xl bg-grouped-card p-3">
          <View style={long && !expanded ? { maxHeight: 240, overflow: "hidden" } : undefined}>
            <PullRequestMarkdown
              markdown={long && !expanded ? comment.body.slice(0, 1200) : comment.body}
              imageGroupMarkdown={comment.body}
            />
          </View>
          {long && !expanded ? (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                { top: undefined, bottom: 0, left: 0, right: 0, height: 80, zIndex: 1 },
              ]}
            >
              <Svg width="100%" height={80}>
                <Defs>
                  <LinearGradient
                    id="comment-fade"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="80"
                    gradientUnits="userSpaceOnUse"
                  >
                    <Stop offset="0" stopColor={colors["--color-grouped-card"]} stopOpacity={0} />
                    <Stop
                      offset="0.5"
                      stopColor={colors["--color-grouped-card"]}
                      stopOpacity={0.94}
                    />
                    <Stop
                      offset="0.72"
                      stopColor={colors["--color-grouped-card"]}
                      stopOpacity={1}
                    />
                    <Stop offset="1" stopColor={colors["--color-grouped-card"]} stopOpacity={1} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill="url(#comment-fade)" />
              </Svg>
              <View
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 22,
                  backgroundColor: colors["--color-grouped-card"],
                }}
              />
            </View>
          ) : null}
          {long ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded(!expanded)}
              hitSlop={8}
              style={
                !expanded
                  ? { position: "absolute", bottom: 2, left: 12, right: 12, height: 44, zIndex: 2 }
                  : undefined
              }
              className="flex-row items-center justify-center gap-1 py-2 active:opacity-70"
            >
              <Text className="text-xs font-t3-medium text-foreground">
                {expanded ? "Show less" : "Show more"}
              </Text>
              <SymbolView
                name={expanded ? "chevron.up" : "chevron.down"}
                size={10}
                tintColorClassName="accent-foreground"
              />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </TimelineEvent>
  );
}

export function pullRequestTimelineRows(
  activity: PullRequestActivity,
  params: PullRequestParams,
  navigation: Pick<NavigationProp<ReactNavigation.RootParamList>, "navigate" | "dispatch">,
) {
  const discussionIds = new Set(
    activity.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  );
  const events = [
    ...activity.comments
      .filter((comment) => !discussionIds.has(comment.id))
      .map((comment) => ({
        key: `comment:${comment.id}`,
        date: comment.createdAt,
        content: <TimelineComment comment={comment} />,
      })),
    ...activity.reviewThreads.map((thread) => ({
      key: `discussion:${thread.id}`,
      date: thread.comments[0]?.createdAt ?? "",
      content: (
        <TimelineEvent icon="text.bubble" tone={thread.isResolved ? "success" : undefined}>
          <View className="flex-row items-center gap-2">
            <PullRequestAvatar actor={thread.comments[0]?.author ?? null} size={22} />
            <Text className="flex-1 text-sm">
              <Text className="font-t3-medium">
                {thread.comments[0]?.author?.login ?? "Unknown author"}
              </Text>
              <Text className="text-foreground-muted"> started a discussion</Text>
            </Text>
            {thread.comments[0] ? (
              <Text className="text-2xs text-foreground-tertiary">
                {relativeTime(thread.comments[0].createdAt)}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${thread.isResolved ? "resolved" : "unresolved"} discussion in ${thread.path}`}
            onPress={() =>
              navigation.navigate("PullRequestDiscussion", { ...params, discussionId: thread.id })
            }
            className="gap-2 rounded-2xl bg-grouped-card p-3 active:opacity-70"
          >
            <View className="flex-row items-center gap-2">
              <SymbolView name="doc.text" size={14} tintColorClassName="accent-icon-muted" />
              <Text className="flex-1 font-mono text-xs" numberOfLines={2}>
                {thread.path}
                {thread.line ? `:${thread.line}` : ""}
              </Text>
              <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
            </View>
            <Text className="text-xs text-foreground-muted">
              {thread.isResolved ? "Resolved" : "Unresolved"}
              {thread.isOutdated ? " · Outdated" : ""} ·{" "}
              {thread.commentCount ?? thread.comments.length} comments
            </Text>
          </Pressable>
        </TimelineEvent>
      ),
    })),
    ...activity.commits.map((commit) => ({
      key: `commit:${commit.oid}`,
      date: commit.committedDate,
      content: (
        <TimelineEvent icon="commit">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`View commit ${commit.oid.slice(0, 7)}, ${commit.messageHeadline}`}
            onPress={() =>
              navigation.dispatch(
                StackActions.push("PullRequestFile", { ...params, commit: commit.oid, path: "" }),
              )
            }
            className="flex-row items-center gap-2 active:opacity-70"
          >
            <PullRequestAvatar actor={commit.authors?.[0] ?? null} size={22} />
            <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>
              {commit.messageHeadline}
            </Text>
            <Text className="font-mono text-2xs text-foreground-muted">
              {commit.oid.slice(0, 7)}
            </Text>
          </Pressable>
        </TimelineEvent>
      ),
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  if (activity.commentsTruncated || activity.reviewThreadsTruncated)
    events.push({
      key: "truncated",
      date: "",
      content: (
        <Text className="py-3 text-xs text-foreground-muted">
          More activity is available on the provider.
        </Text>
      ),
    });
  return events;
}
