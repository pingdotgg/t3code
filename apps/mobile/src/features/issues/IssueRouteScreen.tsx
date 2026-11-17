import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  issueCloseReasonLabel,
  issueEventSentence,
} from "@t3tools/client-runtime/issue-presentation";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { prependIssueComments } from "@t3tools/client-runtime/state/issues";
import type {
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueLinkedPullRequest,
  IssueReaction,
  IssueState,
  IssueSummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Linking, Platform, Pressable, Share, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";

import { RelativeTime } from "../../components/RelativeTime";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useComposerBottomInset } from "../../components/ComposerSurface";
import { ANDROID_READING_MAX_WIDTH, CHAT_CONTENT_MAX_WIDTH } from "../../lib/layout";
import { relativeTime } from "../../lib/time";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "../../lib/reserved-regions";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType, useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { issueEnvironment, refreshIssueLists } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAndroidWorkspaceBack } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { PullRequestDescription } from "../pull-requests/PullRequestDescription";
import {
  PullRequestMarkdown,
  PullRequestMarkdownRepository,
} from "../pull-requests/PullRequestMarkdown";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { ReactionPills } from "../pull-requests/PullRequestReactions";
import { PullRequestSectionHeading } from "../pull-requests/PullRequestSectionHeading";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";
import { usePullRequestConnected } from "../pull-requests/usePullRequestConnected";
import { IssueCommentComposer } from "./IssueCommentComposer";
import { issueIdentity, issueParamsKey, issueTarget, type IssueParams } from "./issueParams";
import {
  IssueLabelPill,
  issueCommandError,
  issueStatus,
  useIssueAccess,
} from "./issuePresentation";

type IssueAccess = NonNullable<ReturnType<typeof useIssueAccess>>;

function IssueReactions(props: {
  readonly params: IssueParams;
  readonly reactions: ReadonlyArray<IssueReaction>;
  readonly canReact: boolean;
  /** Absent reacts to the issue itself. */
  readonly subjectId?: string;
}) {
  const target = issueTarget(props.params);
  const react = useAtomCommand(issueEnvironment.react, { reportFailure: false });
  if (props.reactions.length === 0 && !props.canReact) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      <ReactionPills
        reactions={props.reactions}
        canReact={props.canReact}
        onReact={async (content, reacted) =>
          !AsyncResult.isFailure(
            await react({
              ...target,
              input: {
                ...target.input,
                ...(props.subjectId === undefined ? {} : { subjectId: props.subjectId }),
                content,
                reacted,
              },
            }),
          )
        }
      />
    </View>
  );
}

function IssueStateControl(props: {
  readonly state: IssueState;
  readonly detail: IssueDetail | null;
  readonly states: ReadonlyArray<IssueState>;
  readonly busy: boolean;
  readonly onMove: (state: string, closeReason?: string) => void;
}) {
  const status = issueStatus(props.state);
  const reasons = props.detail?.capabilities.closeReasons ?? [];
  const moves = props.states.flatMap(
    (
      state,
    ): ReadonlyArray<{
      readonly id: string;
      readonly state: string;
      readonly reason?: string;
      readonly title: string;
    }> =>
      state.category === "closed" && reasons.length > 0
        ? reasons.map((reason) => ({
            // No NUL separator: it ends the native string, and UIKit drops a duplicate id.
            id: `${state.name}:${reason}`,
            state: state.name,
            reason,
            title: `${state.name === "closed" ? "Close" : state.name} as ${issueCloseReasonLabel(reason).toLowerCase()}`,
          }))
        : [
            {
              id: state.name,
              state: state.name,
              title:
                state.category === "open" && state.name === "open"
                  ? "Reopen"
                  : state.name === "closed"
                    ? "Close"
                    : `Move to ${state.name}`,
            },
          ],
  );
  const trigger = (
    <Pressable
      accessibilityRole={moves.length ? "button" : undefined}
      accessibilityLabel={`Issue state, ${status.label}`}
      disabled={!moves.length || props.busy}
      className="min-h-8 flex-row items-center gap-1.5 active:opacity-70"
    >
      <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
      <Text className={`text-xs font-t3-medium ${status.text}`}>{status.label}</Text>
      {moves.length ? (
        <SymbolView name="chevron.down" size={9} tintColorClassName="accent-icon-muted" />
      ) : null}
    </Pressable>
  );
  if (!moves.length) return trigger;
  return (
    // As wide as the trigger: iOS anchors the menu to this view, not to the text inside it.
    <View className="self-start">
      <Menu
        title="Issue state"
        actions={moves.map((move) => ({ id: move.id, title: move.title }))}
        onPressAction={({ nativeEvent }) => {
          const move = moves.find((candidate) => candidate.id === nativeEvent.event);
          if (move) props.onMove(move.state, move.reason);
        }}
      >
        {trigger}
      </Menu>
    </View>
  );
}

function IssueIdentity(props: {
  readonly issue: IssueSummary;
  readonly detail: IssueDetail | null;
  readonly access: IssueAccess | null;
  readonly busy: boolean;
  readonly onMove: (state: string, closeReason?: string) => void;
  readonly onEditLabels: () => void;
  readonly onEditAssignees: () => void;
}) {
  const { issue, access } = props;
  const canLabel = access?.labels === true;
  const canAssign = access?.assignees === true;
  return (
    <View className="gap-3">
      <IssueStateControl
        state={issue.state}
        detail={props.detail}
        states={access?.states ?? []}
        busy={props.busy}
        onMove={props.onMove}
      />
      <Text selectable className="text-xl font-t3-bold leading-7">
        {issue.title}
      </Text>
      <View className="flex-row items-center gap-2">
        <PullRequestAvatar actor={issue.author} size={20} />
        <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>
          {issue.author?.login ?? "Unknown author"}
        </Text>
        <Text className="shrink text-right text-2xs text-foreground-muted" numberOfLines={1}>
          {issue.closedAt ? (
            <>
              Closed <RelativeTime timestamp={issue.closedAt} /> ago
            </>
          ) : (
            <>
              Opened <RelativeTime timestamp={issue.createdAt} /> ago
            </>
          )}
        </Text>
      </View>
      {issue.labels.length || canLabel ? (
        <View className="flex-row flex-wrap gap-2">
          {issue.labels.map((label) => (
            <IssueLabelPill key={label.name} label={label} />
          ))}
          {canLabel ? (
            <Chip
              label={issue.labels.length ? "Edit" : "Add labels"}
              icon="tag"
              size="small"
              accessibilityLabel="Edit labels"
              onPress={props.onEditLabels}
            />
          ) : null}
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-xs text-foreground-muted">Assignees</Text>
        {issue.assignees.length === 0 ? (
          <Text className="text-xs text-foreground-muted">none</Text>
        ) : null}
        {issue.assignees.map((actor) => (
          <View key={actor.login} className="flex-row items-center gap-1.5">
            <PullRequestAvatar actor={actor} size={18} />
            <Text className="text-xs font-t3-medium">{actor.login}</Text>
          </View>
        ))}
        {canAssign ? (
          <Chip
            label={issue.assignees.length ? "Edit" : "Assign"}
            icon="person.badge.plus"
            size="small"
            accessibilityLabel="Edit assignees"
            onPress={props.onEditAssignees}
          />
        ) : null}
      </View>
    </View>
  );
}

function LinkedPullRequests(props: {
  readonly params: IssueParams;
  readonly links: ReadonlyArray<IssueLinkedPullRequest>;
}) {
  const navigation = useNavigation();
  // Only a git host's tracker shares its host with the change request it links.
  const sameHost = sourceControlClients.find(props.params.tracker) !== undefined;
  return (
    <View className="gap-2">
      <PullRequestSectionHeading>Linked pull requests</PullRequestSectionHeading>
      {props.links.map((link) => {
        const status = pullRequestStatus(link);
        return (
          <Pressable
            key={`${link.repository}#${link.number}`}
            accessibilityRole="button"
            accessibilityLabel={`${status.label} pull request ${link.number}, ${link.title}`}
            onPress={() =>
              sameHost
                ? navigation.dispatch(
                    StackActions.push("PullRequest", {
                      environmentId: props.params.environmentId,
                      projectId: props.params.projectId,
                      repository: link.repository,
                      number: link.number,
                      ...(props.params.host ? { host: props.params.host } : {}),
                    }),
                  )
                : void Linking.openURL(link.url)
            }
            className="flex-row items-center gap-2 rounded-2xl bg-grouped-card p-3 active:opacity-70"
          >
            <SymbolView name={status.icon} size={15} tintColorClassName={status.tint} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm" numberOfLines={2}>
                {link.title}
              </Text>
              <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
                {link.repository}#{link.number}
                {link.closesIssue ? " · closes" : ""}
              </Text>
            </View>
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
          </Pressable>
        );
      })}
    </View>
  );
}

function IssueCommentCard(props: {
  readonly params: IssueParams;
  readonly comment: IssueComment;
  readonly canReact: boolean;
}) {
  const { comment } = props;
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-3">
      <View className="flex-row items-center gap-2">
        <PullRequestAvatar actor={comment.author} size={22} />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
          {comment.author?.login ?? "Unknown author"}
        </Text>
        <Text className="text-2xs text-foreground-tertiary">{relativeTime(comment.createdAt)}</Text>
      </View>
      <PullRequestMarkdown markdown={comment.body} />
      {comment.reactions !== undefined ? (
        <IssueReactions
          params={props.params}
          reactions={comment.reactions}
          canReact={props.canReact}
          subjectId={comment.id}
        />
      ) : null}
    </View>
  );
}

function IssueEventRow({ event }: { readonly event: IssueEvent }) {
  return (
    <View className="flex-row items-center gap-2 px-1">
      <PullRequestAvatar actor={event.actor} size={18} />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
        <Text className="text-xs font-t3-medium">{event.actor?.login ?? "Someone"}</Text>{" "}
        {issueEventSentence(event)}
      </Text>
      <Text className="text-2xs text-foreground-tertiary">{relativeTime(event.createdAt)}</Text>
    </View>
  );
}

function IssueLoadingBody() {
  return (
    <View className="gap-5" accessibilityLabel="Loading issue" accessibilityState={{ busy: true }}>
      <View className="gap-3">
        <PullRequestSectionHeading>Description</PullRequestSectionHeading>
        <View className="gap-3 py-1">
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-3/4 rounded bg-subtle-strong" />
        </View>
      </View>
      <View className="gap-3">
        <PullRequestSectionHeading>Activity</PullRequestSectionHeading>
        <View className="h-20 rounded-2xl bg-subtle-strong" />
        <View className="h-20 rounded-2xl bg-subtle-strong" />
      </View>
    </View>
  );
}

// Selecting another issue reuses this route, so the draft, older comments and errors are keyed.
export function IssueRouteScreen({ route }: StaticScreenProps<IssueParams>) {
  return <IssueRoute key={issueParamsKey(route.params)} params={route.params} />;
}

function IssueRoute({ params }: { readonly params: IssueParams }) {
  const identity = issueIdentity(params);
  const target = issueTarget(params);
  const navigation = useNavigation();
  const returnToList = useAndroidWorkspaceBack();
  const { layout } = useAdaptiveWorkspaceLayout();
  const composerBottomInset = useComposerBottomInset();
  const deviceType = useDeviceType();
  // The thread screen's composer host: the same metrics, so the same reserved regions and insets.
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const [screenMetrics, setScreenMetrics] = useState<NativeLayoutMetrics | null>(null);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const controlInsets = deriveBottomControlInsets(
    usesNativeWorkspaceColumns ? columnMetrics : screenMetrics,
  );
  const [composerFocused, setComposerFocused] = useState(false);
  const connected = usePullRequestConnected(params.environmentId);
  const detailAtom = issueEnvironment.detail(target);
  const detailQuery = useEnvironmentQuery(detailAtom);
  const pullRefresh = usePullToRefresh(detailAtom);
  const detail = detailQuery.data;
  const issue: IssueSummary | null = detail ?? params.initialSummary ?? null;
  const access = useIssueAccess(params, detail);

  const loadComments = useAtomCommand(issueEnvironment.comments, { reportFailure: false });
  const postComment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const [older, setOlder] = useState<{
    readonly seed: string | null;
    readonly comments: ReadonlyArray<IssueComment>;
    readonly cursor: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<"older" | "comment" | "state" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);

  // Older pages are tied to the cursor the detail was read with; a refreshed detail starts over.
  const olderComments = detail && older?.seed === detail.commentsCursor ? older.comments : [];
  const nextCursor = !detail
    ? null
    : older?.seed === detail.commentsCursor
      ? older.cursor
      : detail.commentsCursor;
  const timeline = detail
    ? [
        ...prependIssueComments(detail.comments, olderComments).map((comment) => ({
          key: `c:${comment.id}`,
          at: comment.createdAt,
          content: (
            <IssueCommentCard params={params} comment={comment} canReact={access?.react === true} />
          ),
        })),
        ...detail.events.map((event) => ({
          key: `e:${event.id}`,
          at: event.createdAt,
          content: <IssueEventRow event={event} />,
        })),
      ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    : [];

  const run = async (
    kind: NonNullable<typeof busy>,
    command: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
  ) => {
    if (busy !== null) return false;
    setBusy(kind);
    setError(null);
    const failure = issueCommandError(await command());
    setBusy(null);
    setError(failure);
    // The list beside this issue shows its state and comment count, and reads only when asked.
    if (failure === null) refreshIssueLists(target.environmentId);
    return failure === null;
  };
  // Counts refreshes, so a page asked for before one is not laid over the read that follows it.
  const refreshes = useRef(0);
  const loadOlder = async () => {
    if (!detail || nextCursor === null || busy !== null) return;
    const asked = refreshes.current;
    setBusy("older");
    setError(null);
    const result = await loadComments({
      ...target,
      input: { ...target.input, cursor: nextCursor },
    });
    setBusy(null);
    if (asked !== refreshes.current) return;
    if (AsyncResult.isFailure(result)) {
      setError("Older comments could not be read.");
      return;
    }
    setOlder({
      seed: detail.commentsCursor,
      comments: prependIssueComments(olderComments, result.value.comments),
      cursor: result.value.nextCursor,
    });
  };
  const submitComment = (body: string) =>
    access?.comment === true
      ? run("comment", () => postComment({ ...target, input: { ...target.input, body } }))
      : Promise.resolve(false);
  const moveTo = (state: string, closeReason?: string) =>
    void run("state", () =>
      setState({
        ...target,
        input: { ...target.input, state, ...(closeReason === undefined ? {} : { closeReason }) },
      }),
    );

  const showComposer = detail?.capabilities.comment === true;
  const commentBlocked =
    access?.comment === true ? null : (access?.blocked ?? "You cannot comment here.");
  const contentMaxWidth =
    Platform.OS === "android"
      ? ANDROID_READING_MAX_WIDTH
      : layout.usesSplitView
        ? CHAT_CONTENT_MAX_WIDTH
        : undefined;
  const url = issue?.url;
  return (
    <PullRequestMarkdownRepository
      params={{
        environmentId: params.environmentId,
        projectId: params.projectId,
        repository: params.scope,
        number: 0,
      }}
      changeRequest={detail ? { provider: detail.tracker, url: detail.url } : null}
    >
      <View className="flex-1 bg-screen">
        <AppBar
          title={issue?.displayKey ?? params.issueKey}
          subtitle={connected ? params.scope : `${params.scope} · Offline`}
          onBack={layout.usesSplitView ? undefined : returnToList}
          menus={[
            {
              title: "Issue actions",
              icon: "ellipsis",
              items: [
                ...(access?.edit
                  ? [
                      {
                        id: "edit-title",
                        title: "Edit title",
                        icon: "pencil",
                        onPress: () =>
                          navigation.navigate("IssueEdit", { ...identity, field: "title" }),
                      },
                      {
                        id: "edit-description",
                        title: "Edit description",
                        icon: "doc.text",
                        onPress: () =>
                          navigation.navigate("IssueEdit", { ...identity, field: "body" }),
                      },
                    ]
                  : []),
                ...(url
                  ? [
                      {
                        id: "open-on-host",
                        title: "Open on the tracker",
                        icon: "arrow.up.right",
                        onPress: () => void Linking.openURL(url),
                      },
                      {
                        id: "copy-link",
                        title: "Copy link",
                        icon: "link",
                        onPress: () => copyTextWithHaptic(url, { target: "issue link" }),
                      },
                      {
                        id: "share",
                        title: "Share…",
                        icon: "square.and.arrow.up",
                        onPress: () =>
                          // Android ignores `url`; iOS shows a `message` URL as plain text.
                          void Share.share(
                            Platform.OS === "ios" ? { url } : { message: url },
                          ).catch(() => undefined),
                      },
                    ]
                  : []),
              ],
            },
          ]}
        />
        {!usesNativeWorkspaceColumns ? <NativeLayoutObserver onChange={setScreenMetrics} /> : null}
        {/* Not a bare marker: Android wraps a refreshable scroll view, which the marker rejects. */}
        <NativeScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          refreshControl={
            <RefreshControl
              refreshing={pullRefresh.refreshing}
              onRefresh={() => {
                // Older pages are cached under the cursor, which a refresh can hand back unchanged.
                refreshes.current += 1;
                setOlder(null);
                pullRefresh.onRefresh();
              }}
            />
          }
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: showComposer ? composerHeight + 16 : 24,
          }}
        >
          {!issue ? (
            detailQuery.error && !detailQuery.isPending ? (
              <EmptyState
                title="Couldn't load this issue"
                detail={detailQuery.error}
                variant="plain"
              />
            ) : (
              <AppActivityIndicator className="my-12" colorClassName="accent-icon" />
            )
          ) : (
            <View className="gap-5">
              <IssueIdentity
                issue={issue}
                detail={detail}
                access={access}
                busy={busy === "state"}
                onMove={moveTo}
                onEditLabels={() => navigation.navigate("IssueLabels", identity)}
                onEditAssignees={() => navigation.navigate("IssueAssignees", identity)}
              />
              {error || (detail && detailQuery.error) ? (
                <Text selectable className="text-sm text-danger-foreground">
                  {error ?? detailQuery.error}
                </Text>
              ) : null}
              {!detail ? (
                detailQuery.error && !detailQuery.isPending ? (
                  <EmptyState
                    title="Couldn't load this issue"
                    detail={detailQuery.error}
                    variant="plain"
                  />
                ) : (
                  <IssueLoadingBody />
                )
              ) : (
                <>
                  <PullRequestDescription
                    markdown={detail.body}
                    footer={
                      detail.reactions !== undefined ? (
                        <IssueReactions
                          params={params}
                          reactions={detail.reactions}
                          canReact={access?.react === true}
                        />
                      ) : undefined
                    }
                  />
                  {detail.linkedPullRequests.length > 0 ? (
                    <LinkedPullRequests params={params} links={detail.linkedPullRequests} />
                  ) : null}
                  <View className="gap-3">
                    <PullRequestSectionHeading>
                      Activity
                      {detail.commentCount > 0
                        ? ` · ${detail.commentCount} ${detail.commentCount === 1 ? "comment" : "comments"}`
                        : ""}
                    </PullRequestSectionHeading>
                    {nextCursor !== null ? (
                      <Button
                        label={busy === "older" ? "Loading…" : "Load older comments"}
                        disabled={busy !== null}
                        onPress={() => void loadOlder()}
                      />
                    ) : null}
                    {timeline.length === 0 ? (
                      <Text className="text-sm text-foreground-muted">
                        Nothing has happened here yet.
                      </Text>
                    ) : null}
                    {timeline.map((item) => (
                      <View key={item.key}>{item.content}</View>
                    ))}
                  </View>
                </>
              )}
            </View>
          )}
        </NativeScrollView>
        {showComposer ? (
          <KeyboardStickyView
            // On the unfolded Duo the sidebar's search shares the keyboard; follow it only for ours.
            enabled={deviceType !== "duo-unfolded" || composerFocused}
            pointerEvents="box-none"
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
            offset={{ closed: 0, opened: composerBottomInset }}
          >
            <View
              pointerEvents="box-none"
              style={{
                position: "absolute",
                bottom: controlInsets.bottom,
                left: controlInsets.left,
                right: controlInsets.right,
              }}
            >
              <IssueCommentComposer
                ownerKey={`issue-comment:${issueParamsKey(params)}`}
                label={issue?.displayKey ?? params.issueKey}
                blocked={commentBlocked}
                posting={busy === "comment"}
                bottomInset={composerBottomInset}
                contentMaxWidth={contentMaxWidth}
                onSubmit={submitComment}
                onHeightChange={setComposerHeight}
                onFocusChange={setComposerFocused}
              />
            </View>
          </KeyboardStickyView>
        ) : null}
      </View>
    </PullRequestMarkdownRepository>
  );
}
