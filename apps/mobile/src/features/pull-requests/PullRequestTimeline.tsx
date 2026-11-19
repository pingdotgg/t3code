import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
} from "@t3tools/shared/pullRequestAnchor";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  pullRequestConversationThreads,
  type PullRequestActivity,
  type PullRequestActor,
  type PullRequestComment,
  type PullRequestConversationThread,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { StackActions, type NavigationProp } from "@react-navigation/native";
import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { parseMarkdownDocument } from "../../lib/markdownDocument";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { byTimestamp, relativeTime } from "../../lib/time";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestCommentFooter } from "./PullRequestReactions";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";
import { normalizedReviewState, pullRequestStatus } from "./pullRequestStatus";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { MessageResolver } from "../../i18n/messages";

const MARKER = 24;

/** Where a row sits on the rail: the rail runs from the first marker to the last. */
type RailPosition = { readonly first: boolean; readonly last: boolean };

/**
 * One timeline row: a 24pt marker on the rail, a title line and a meta line at the same size,
 * then any cards. Text starts 36pt in.
 */
function RailRow(props: {
  readonly position: RailPosition;
  readonly marker: ReactNode;
  readonly title?: ReactNode;
  readonly meta?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
}) {
  const { first, last } = props.position;
  const heading =
    props.title !== undefined ? (
      <View className="flex-row items-start gap-2">
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] leading-6 font-t3-medium text-foreground">
            {props.title}
          </Text>
          {props.meta !== undefined ? (
            <Text className="text-[15px] leading-6 text-foreground-muted" numberOfLines={2}>
              {props.meta}
            </Text>
          ) : null}
        </View>
        {props.trailing}
      </View>
    ) : null;
  return (
    <View className="px-4">
      <View className="relative py-3" style={{ paddingLeft: MARKER + 12 }}>
        {first && last ? null : (
          <View
            className="absolute w-px bg-border"
            style={{
              left: MARKER / 2 - 0.5,
              top: first ? 12 + MARKER / 2 : 0,
              ...(last ? { height: 12 + MARKER / 2 } : { bottom: 0 }),
            }}
          />
        )}
        <View
          className="absolute items-center justify-center rounded-full bg-screen"
          style={{ left: 0, top: 12, width: MARKER, height: MARKER }}
        >
          {props.marker}
        </View>
        {heading && props.onPress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            onPress={props.onPress}
            className="active:opacity-70"
          >
            {heading}
          </Pressable>
        ) : (
          heading
        )}
        {props.children ? (
          <View className={props.title !== undefined ? "mt-3" : undefined}>{props.children}</View>
        ) : null}
      </View>
    </View>
  );
}

/** An event's icon in a circle tinted with its colour, such as the state of the pull request. */
function EventMarker(props: {
  readonly icon: AppSymbolName;
  readonly tint: string;
  readonly background: string;
}) {
  return (
    <View
      className={cn("items-center justify-center rounded-full", props.background)}
      style={{ width: MARKER, height: MARKER }}
    >
      <SymbolView name={props.icon} size={13} weight="semibold" tintColorClassName={props.tint} />
    </View>
  );
}

function ActorMarker(props: { readonly actor: PullRequestActor | null }) {
  return <PullRequestAvatar actor={props.actor} size={MARKER} />;
}

/** A comment as its own card: one header row (name and time), then the text. */
function CommentCard(props: {
  readonly author: PullRequestActor | null;
  readonly createdAt: string;
  readonly body: string;
  readonly linked?: boolean;
  readonly footer?: ReactNode;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { themeVariables: colors } = useAppearancePreferences();
  const [expanded, setExpanded] = useState(props.linked === true);
  const long = props.body.length > 450 || props.body.split("\n").length > 8;
  const content = useMemo(
    () => pullRequestDescriptionContent(parseMarkdownDocument(props.body), [], messages),
    [props.body, messages],
  );
  const empty = !content.preview.trim() && content.attachments.length === 0;
  const surface = colors["--color-screen"];
  return (
    <View
      className={cn(
        "overflow-hidden rounded-2xl border",
        props.linked ? "border-primary" : "border-border",
      )}
    >
      {/* The name and time fit one row on a phone, so the header drops "commented". */}
      <View className="min-h-11 flex-row items-center border-b border-border bg-foreground/5 px-3">
        <Text className="min-w-0 flex-1 text-[15px]" numberOfLines={1}>
          <Text className="font-t3-medium text-foreground">
            {props.author?.login ?? gt("Unknown author")}
          </Text>
          <Text className="text-foreground-muted">
            {" · "}
            {gt("{time} ago", { time: relativeTime(props.createdAt, undefined, messages) })}
          </Text>
        </Text>
      </View>
      {empty ? null : (
        <View className="p-3">
          <View style={long && !expanded ? { maxHeight: 240, overflow: "hidden" } : undefined}>
            <PullRequestMarkdown
              markdown={long && !expanded ? props.body.slice(0, 1200) : props.body}
              imageGroupMarkdown={props.body}
            />
          </View>
          {long && !expanded ? (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                { top: undefined, bottom: 0, height: 80, zIndex: 1 },
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
                    <Stop offset="0" stopColor={surface} stopOpacity={0} />
                    <Stop offset="0.5" stopColor={surface} stopOpacity={0.94} />
                    <Stop offset="0.72" stopColor={surface} stopOpacity={1} />
                    <Stop offset="1" stopColor={surface} stopOpacity={1} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill="url(#comment-fade)" />
              </Svg>
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
                {expanded ? gt("Show less") : gt("Show more")}
              </Text>
              <SymbolView
                name={expanded ? "chevron.up" : "chevron.down"}
                size={10}
                tintColorClassName="accent-foreground"
              />
            </Pressable>
          ) : null}
        </View>
      )}
      {props.footer ? <View className="px-3 pb-3">{props.footer}</View> : null}
    </View>
  );
}

/** A reply: its own card, 24pt in, joined to the card it answers by a thin elbow. */
function ReplyCard(props: { readonly children: ReactNode }) {
  return (
    <View className="relative mt-2 pl-6">
      <View className="absolute w-px bg-border" style={{ left: 12, top: -8, height: 30 }} />
      <View className="absolute h-px bg-border" style={{ left: 12, top: 22, width: 12 }} />
      {props.children}
    </View>
  );
}

type CommentActions = {
  readonly permissions: ComponentProps<typeof PullRequestCommentFooter>["permissions"];
  readonly onChanged: () => void;
};

function TimelineComment({
  comment,
  params,
  actions,
  position,
}: {
  comment: PullRequestComment;
  params: PullRequestParams;
  actions: CommentActions;
  position: RailPosition;
}) {
  const target = parsePullRequestAnchor(params.navigationUrl);
  const linked =
    target?.kind === "timeline" && pullRequestAnchorMatchesUrl(target.anchor, comment.url);
  const gt = useGT();
  const messages = useMessages();
  const state = normalizedReviewState(comment.reviewState);
  const approved = state === "APPROVED";
  const changes = state === "CHANGES_REQUESTED";
  const login = comment.author?.login ?? gt("Unknown author");
  const footer = (
    <PullRequestCommentFooter
      params={params}
      comment={comment}
      permissions={actions.permissions}
      onChanged={actions.onChanged}
    />
  );
  const card = (
    <CommentCard
      author={comment.author}
      createdAt={comment.createdAt}
      body={comment.body}
      linked={linked}
      footer={footer}
    />
  );
  // A verdict without text keeps its reactions under its title line.
  const hasFooter =
    (comment.reactions?.length ?? 0) > 0 ||
    actions.permissions.canReactComment(comment) ||
    (comment.kind !== "review" && actions.permissions.canEditComment(comment));
  if (!approved && !changes)
    return (
      <RailRow position={position} marker={<ActorMarker actor={comment.author} />}>
        {card}
      </RailRow>
    );
  return (
    <RailRow
      position={position}
      marker={
        <EventMarker
          icon={approved ? "checkmark" : "plusminus"}
          tint={approved ? "accent-adaptive-emerald-600-400" : "accent-danger-foreground"}
          background={approved ? "bg-adaptive-emerald-500-a12-a16" : "bg-danger"}
        />
      }
      title={
        approved ? (
          <T>
            <Var>{login}</Var> <Text className="font-normal text-foreground-muted">approved</Text>
          </T>
        ) : (
          <T>
            <Var>{login}</Var>{" "}
            <Text className="font-normal text-foreground-muted">requested changes</Text>
          </T>
        )
      }
      meta={gt("{time} ago", { time: relativeTime(comment.createdAt, undefined, messages) })}
    >
      {comment.body.trim() ? card : hasFooter ? footer : null}
    </RailRow>
  );
}

function TimelineThread(props: {
  readonly thread: PullRequestConversationThread;
  readonly params: PullRequestParams;
  readonly onOpen: () => void;
  readonly position: RailPosition;
}) {
  const { thread } = props;
  const gt = useGT();
  const messages = useMessages();
  const [first, ...replies] = thread.comments;
  const count = thread.commentCount ?? thread.comments.length;
  const name =
    thread.path === null ? gt("Overview") : (thread.path.split("/").at(-1) ?? thread.path);
  const meta = [
    thread.isOutdated ? messages(msg("Outdated", { $context: "review thread state" })) : null,
    first?.author?.login ?? null,
    count > 1
      ? messages(
          msg("{count, plural, one {{count} reply} other {{count} replies}}", { count: count - 1 }),
        )
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <RailRow
      position={props.position}
      marker={<ActorMarker actor={first?.author ?? null} />}
      accessibilityLabel={
        thread.path === null
          ? thread.isResolved
            ? gt("Open resolved discussion in the overview")
            : gt("Open unresolved discussion in the overview")
          : thread.isResolved
            ? gt("Open resolved discussion in {path}", { path: thread.path })
            : gt("Open unresolved discussion in {path}", { path: thread.path })
      }
      onPress={props.onOpen}
      title={
        <>
          {thread.path === null ? null : (
            <SymbolView name="doc.text" size={14} tintColorClassName="accent-icon-muted" />
          )}
          {thread.path === null ? "" : " "}
          {name}
        </>
      }
      meta={
        <>
          {thread.isResolved ? (
            <Text className="text-adaptive-emerald-600-400">
              {messages(msg("Resolved", { $context: "review thread state" }))}
              {meta.length ? " · " : ""}
            </Text>
          ) : null}
          {meta.join(" · ")}
        </>
      }
      trailing={
        <View className="h-6 justify-center">
          <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
        </View>
      }
    >
      {first ? (
        <CommentCard author={first.author} createdAt={first.createdAt} body={first.body} />
      ) : null}
      {replies.map((reply) => (
        <ReplyCard key={reply.id}>
          <CommentCard author={reply.author} createdAt={reply.createdAt} body={reply.body} />
        </ReplyCard>
      ))}
    </RailRow>
  );
}

function LifecycleEvent(props: {
  readonly kind: "opened" | "merged" | "closed";
  readonly actor: PullRequestActor | null;
  readonly at: string;
  readonly position: RailPosition;
}) {
  const gt = useGT();
  const messages = useMessages();
  const status = pullRequestStatus(
    { state: props.kind === "opened" ? "open" : props.kind, isDraft: false },
    messages,
  );
  const login = props.actor?.login ?? gt("Unknown author");
  return (
    <RailRow
      position={props.position}
      marker={<EventMarker icon={status.icon} tint={status.tint} background={status.background} />}
      title={
        props.kind === "opened" ? (
          <T>
            <Var>{login}</Var>{" "}
            <Text className="font-normal text-foreground-muted">opened this pull request</Text>
          </T>
        ) : props.kind === "merged" ? (
          <T>
            <Var>{login}</Var>{" "}
            <Text className="font-normal text-foreground-muted">merged this pull request</Text>
          </T>
        ) : (
          <T>
            <Var>{login}</Var>{" "}
            <Text className="font-normal text-foreground-muted">closed this pull request</Text>
          </T>
        )
      }
      meta={gt("{time} ago", { time: relativeTime(props.at, undefined, messages) })}
    />
  );
}

export function pullRequestTimelineRows(
  activity: PullRequestActivity,
  params: PullRequestParams,
  navigation: Pick<NavigationProp<ReactNavigation.RootParamList>, "navigate" | "dispatch">,
  actions: CommentActions,
  newestFirst: boolean,
  resolve: MessageResolver,
  /** Opened, merged and closed, as events on the rail; null while the pull request loads. */
  lifecycle: Pick<
    PullRequestDetail,
    "author" | "createdAt" | "mergedAt" | "mergedBy" | "closedAt" | "state"
  > | null,
) {
  const linkTarget = parsePullRequestAnchor(params.navigationUrl);
  const threads = pullRequestConversationThreads(activity);
  const discussionIds = new Set(
    threads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  );
  const events: Array<{
    key: string;
    date: string;
    render: (position: RailPosition) => ReactNode;
  }> = [
    ...activity.comments
      .filter((comment) => !discussionIds.has(comment.id))
      .map((comment) => ({
        key: `comment:${comment.id}`,
        date: comment.createdAt,
        render: (position: RailPosition) => (
          <TimelineComment
            key={
              linkTarget?.kind === "timeline" &&
              pullRequestAnchorMatchesUrl(linkTarget.anchor, comment.url)
                ? `${comment.id}:${params.navigationId ?? params.navigationUrl}`
                : comment.id
            }
            comment={comment}
            params={params}
            actions={actions}
            position={position}
          />
        ),
      })),
    ...threads.map((thread) => ({
      key: `discussion:${thread.id}`,
      date: thread.comments[0]?.createdAt ?? "",
      render: (position: RailPosition) => (
        <TimelineThread
          thread={thread}
          params={params}
          position={position}
          onOpen={() =>
            navigation.navigate("PullRequestDiscussion", { ...params, discussionId: thread.id })
          }
        />
      ),
    })),
    ...activity.commits.map((commit) => ({
      key: `commit:${commit.oid}`,
      date: commit.committedDate,
      render: (position: RailPosition) => (
        <RailRow
          position={position}
          marker={<ActorMarker actor={commit.authors?.[0] ?? null} />}
          accessibilityLabel={resolve(
            msg("View commit {sha}, {headline}", {
              sha: commit.oid.slice(0, 7),
              headline: commit.messageHeadline,
            }),
          )}
          onPress={() =>
            navigation.dispatch(
              StackActions.push("PullRequestFile", { ...params, commit: commit.oid, path: "" }),
            )
          }
          title={commit.messageHeadline}
          meta={`${commit.oid.slice(0, 7)} · ${resolve(
            msg("{time} ago", { time: relativeTime(commit.committedDate, undefined, resolve) }),
          )}`}
        />
      ),
    })),
    ...(lifecycle
      ? [
          {
            key: "lifecycle:opened",
            date: lifecycle.createdAt,
            render: (position: RailPosition) => (
              <LifecycleEvent
                kind="opened"
                actor={lifecycle.author}
                at={lifecycle.createdAt}
                position={position}
              />
            ),
          },
          ...(lifecycle.mergedAt
            ? [
                {
                  key: "lifecycle:merged",
                  date: lifecycle.mergedAt,
                  render: (position: RailPosition) => (
                    <LifecycleEvent
                      kind="merged"
                      actor={lifecycle.mergedBy ?? null}
                      at={lifecycle.mergedAt ?? ""}
                      position={position}
                    />
                  ),
                },
              ]
            : lifecycle.state === "closed" && lifecycle.closedAt
              ? [
                  {
                    key: "lifecycle:closed",
                    date: lifecycle.closedAt,
                    render: (position: RailPosition) => (
                      <LifecycleEvent
                        kind="closed"
                        actor={null}
                        at={lifecycle.closedAt ?? ""}
                        position={position}
                      />
                    ),
                  },
                ]
              : []),
        ]
      : []),
  ].sort(byTimestamp(newestFirst));
  const rows: Array<{ key: string; date: string; content: ReactNode }> = events.map(
    (event, index) => ({
      key: event.key,
      date: event.date,
      content: event.render({ first: index === 0, last: index === events.length - 1 }),
    }),
  );
  if (activity.commentsTruncated || activity.reviewThreadsTruncated)
    rows.push({
      key: "truncated",
      date: "",
      content: (
        <Text className="px-4 py-3 text-xs text-foreground-muted">
          <T>More activity is available on the provider.</T>
        </Text>
      ),
    });
  return rows;
}
