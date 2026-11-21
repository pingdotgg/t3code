import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { issueEventSentence } from "@t3tools/client-runtime/issue-presentation";
import { pinnedIssueProperties } from "@t3tools/client-runtime/issue-properties";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { createIssueCommentPager } from "@t3tools/client-runtime/state/issues";
import { visibleLinkedThreads } from "@t3tools/client-runtime/state/threads";
import type {
  IssueComment,
  IssueEvent,
  IssueLinkedPullRequest,
  IssueReaction,
  IssueState,
  IssueSummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { useContext, useState } from "react";
import { Keyboard, Platform, Pressable, Share, View } from "react-native";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
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
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useComposerBottomInset } from "../../components/ComposerSurface";
import { ANDROID_READING_MAX_WIDTH, CHAT_CONTENT_MAX_WIDTH } from "../../lib/layout";
import { relativeTime } from "../../lib/time";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "../../lib/reserved-regions";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType, useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useEnvironmentServerConfig } from "../../state/entities";
import { issueEnvironment, refreshIssueLists } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
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
import { IssuePropertiesView, IssuePropertyRow } from "./IssuePropertiesView";
import { issueIdentity, issueParamsKey, issueTarget, type IssueParams } from "./issueParams";
import {
  IssueLabelPill,
  issueCommandError,
  issueStatus,
  useIssueAccess,
} from "./issuePresentation";
import { useIssuePropertyPins } from "./useIssuePropertyPins";

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
  readonly states: ReadonlyArray<IssueState>;
  readonly busy: boolean;
  readonly onMove: (state: string) => void;
}) {
  const gt = useGT();
  const status = issueStatus(props.state);
  const moves = props.states;
  const trigger = (
    <Pressable
      accessibilityRole={moves.length ? "button" : undefined}
      accessibilityLabel={gt("Issue state, {state}", { state: status.label })}
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
        title={gt("Issue state")}
        // The name is the id: unique within a workflow, and a NUL separator would end the native string.
        actions={moves.map((move) => ({ id: move.name, title: move.name }))}
        onPressAction={({ nativeEvent }) => {
          if (moves.some((move) => move.name === nativeEvent.event))
            props.onMove(nativeEvent.event);
        }}
      >
        {trigger}
      </Menu>
    </View>
  );
}

function IssueIdentity(props: {
  readonly issue: IssueSummary;
  readonly access: IssueAccess | null;
  readonly busy: boolean;
  readonly onMove: (state: string) => void;
  readonly onEditLabels: () => void;
  readonly onEditAssignees: () => void;
}) {
  const gt = useGT();
  const { issue, access } = props;
  const canLabel = access?.labels === true;
  const canAssign = access?.assignees === true;
  return (
    <View className="gap-3">
      <IssueStateControl
        state={issue.state}
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
          {issue.author?.login ?? gt("Unknown author")}
        </Text>
        <Text className="shrink text-right text-2xs text-foreground-muted" numberOfLines={1}>
          {issue.closedAt ? (
            <T>
              Closed{" "}
              <Var>
                <RelativeTime timestamp={issue.closedAt} />
              </Var>{" "}
              ago
            </T>
          ) : (
            <T>
              Opened{" "}
              <Var>
                <RelativeTime timestamp={issue.createdAt} />
              </Var>{" "}
              ago
            </T>
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
              label={
                issue.labels.length
                  ? gt("Edit", { $context: "verb, edits labels" })
                  : gt("Add labels")
              }
              icon="tag"
              size="small"
              accessibilityLabel={gt("Edit labels")}
              onPress={props.onEditLabels}
            />
          ) : null}
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-xs text-foreground-muted">
          <T>Assignees</T>
        </Text>
        {issue.assignees.length === 0 ? (
          <Text className="text-xs text-foreground-muted">
            <T context="no assignees">none</T>
          </Text>
        ) : null}
        {issue.assignees.map((actor) => (
          <View key={actor.login} className="flex-row items-center gap-1.5">
            <PullRequestAvatar actor={actor} size={18} />
            <Text className="text-xs font-t3-medium">{actor.login}</Text>
          </View>
        ))}
        {canAssign ? (
          <Chip
            label={
              issue.assignees.length
                ? gt("Edit", { $context: "verb, edits assignees" })
                : gt("Assign", { $context: "verb, assigns people to an issue" })
            }
            icon="person.badge.plus"
            size="small"
            accessibilityLabel={gt("Edit assignees")}
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
  const gt = useGT();
  const navigation = useNavigation();
  // Only a git host's tracker shares its host with the change request it links.
  const sameHost = sourceControlClients.find(props.params.tracker) !== undefined;
  return (
    <View className="gap-2">
      <PullRequestSectionHeading>
        <T>Linked pull requests</T>
      </PullRequestSectionHeading>
      {props.links.map((link) => {
        const status = pullRequestStatus(link);
        return (
          <Pressable
            key={`${link.repository}#${link.number}`}
            accessibilityRole="button"
            accessibilityLabel={gt("{status} pull request {number}, {title}", {
              status: status.label,
              number: String(link.number),
              title: link.title,
            })}
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
                : void tryOpenExternalUrl(link.url)
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
                {link.closesIssue
                  ? ` · ${gt("closes", { $context: "the pull request closes this issue" })}`
                  : ""}
              </Text>
            </View>
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
          </Pressable>
        );
      })}
    </View>
  );
}

/** The threads this issue is linked to, most recently active first; hidden while there are none. */
function LinkedThreads(props: { readonly params: IssueParams; readonly host: string }) {
  const gt = useGT();
  const navigation = useNavigation();
  const { environmentId, input } = issueTarget(props.params);
  const listsThreads =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.issueLinkedThreads === true;
  const relations = useEnvironmentQuery(
    listsThreads
      ? issueEnvironment.linkedThreads({
          environmentId,
          input: { tracker: input.tracker, host: props.host, scope: input.scope, key: input.key },
        })
      : null,
  );
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const hidingAnywhere = useAtomValue(environmentThreadShells.anyEnvironmentHidingAtom);
  const loadedThreadRefs = useAtomValue(
    environmentThreadShells.environmentThreadRefsAtom(environmentId),
  );
  const threads = visibleLinkedThreads(
    relations.data?.threads ?? [],
    environmentId,
    loadedThreadRefs,
    hiddenKeys,
    hidingAnywhere,
  );
  if (threads.length === 0) return null;
  return (
    <View className="gap-2">
      <PullRequestSectionHeading>
        <T>Linked threads</T>
      </PullRequestSectionHeading>
      {threads.map((thread) => {
        const title = thread.title || gt("Untitled thread");
        return (
          <Pressable
            key={thread.id}
            accessibilityRole="button"
            accessibilityLabel={gt("Open thread {title}", { title })}
            onPress={() =>
              navigation.dispatch(
                StackActions.push("Thread", {
                  environmentId: props.params.environmentId,
                  threadId: thread.id,
                }),
              )
            }
            className="flex-row items-center gap-2 rounded-2xl bg-grouped-card p-3 active:opacity-70"
          >
            <SymbolView name="bubble.left" size={15} tintColorClassName="accent-icon-muted" />
            <View className="min-w-0 flex-1">
              <Text className="text-sm" numberOfLines={2}>
                {title}
              </Text>
              {thread.archivedAt !== null ? (
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  <T>Archived thread</T>
                </Text>
              ) : null}
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
  const gt = useGT();
  const messages = useMessages();
  const { comment } = props;
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-3">
      <View accessible accessibilityRole="header" className="flex-row items-center gap-2">
        <PullRequestAvatar actor={comment.author} size={22} />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
          {comment.author?.login ?? gt("Unknown author")}
        </Text>
        <Text className="text-2xs text-foreground-tertiary">
          {relativeTime(comment.createdAt, undefined, messages)}
        </Text>
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
  const gt = useGT();
  const messages = useMessages();
  return (
    <View className="flex-row items-center gap-2 px-1">
      <PullRequestAvatar actor={event.actor} size={18} />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
        <Text className="text-xs font-t3-medium">
          {event.actor?.login ?? gt("Someone", { $context: "an unknown person" })}
        </Text>{" "}
        {issueEventSentence(event, messages)}
      </Text>
      <Text className="text-2xs text-foreground-tertiary">
        {relativeTime(event.createdAt, undefined, messages)}
      </Text>
    </View>
  );
}

function IssueLoadingBody() {
  const gt = useGT();
  return (
    <View
      className="gap-5"
      accessibilityLabel={gt("Loading issue")}
      accessibilityState={{ busy: true }}
    >
      <View className="gap-3">
        <PullRequestSectionHeading>
          <T>Description</T>
        </PullRequestSectionHeading>
        <View className="gap-3 py-1">
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-3/4 rounded bg-subtle-strong" />
        </View>
      </View>
      <View className="gap-3">
        <PullRequestSectionHeading>
          <T>Activity</T>
        </PullRequestSectionHeading>
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
  const gt = useGT();
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
  const registry = useContext(RegistryContext);
  const [pager] = useState(() => createIssueCommentPager(detailAtom));
  const { comments, nextCursor, loadingOlder, canLoadOlder } = useAtomValue(pager.view);
  const detail = detailQuery.data;
  const issue: IssueSummary | null = detail ?? params.initialSummary ?? null;
  const access = useIssueAccess(params, detail);
  const pins = useIssuePropertyPins(detail);
  const [selectedTab, setSelectedTab] = useState<"overview" | "properties">("overview");
  const properties = detail?.properties;
  // A server from before properties sends none, and the screen shows only the overview.
  const tab = properties === undefined ? "overview" : selectedTab;
  const pinned = properties === undefined ? [] : pinnedIssueProperties(properties, pins.ids);

  const loadComments = useAtomCommand(issueEnvironment.comments, { reportFailure: false });
  const postComment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const [busy, setBusy] = useState<"comment" | "state" | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [olderCommentsError, setOlderCommentsError] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);

  const timeline = detail
    ? [
        ...comments.map((comment) => ({
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
    setMutationError(null);
    const failure = issueCommandError(await command());
    setBusy(null);
    setMutationError(failure);
    // The list beside this issue shows its state and comment count, and reads only when asked.
    if (failure === null) refreshIssueLists(target.environmentId);
    return failure === null;
  };
  const loadOlder = async () => {
    if (busy !== null) return;
    const failure = await pager.loadOlder(registry, (cursor) => {
      setOlderCommentsError(null);
      return loadComments({ ...target, input: { ...target.input, cursor } });
    });
    if (failure) setOlderCommentsError(gt("Older comments could not be read."));
  };
  const submitComment = (body: string) =>
    access?.comment === true
      ? run("comment", () => postComment({ ...target, input: { ...target.input, body } }))
      : Promise.resolve(false);
  const moveTo = (state: string) =>
    void run("state", () => setState({ ...target, input: { ...target.input, state } }));

  const showComposer = detail?.capabilities.comment === true;
  const commentBlocked =
    access?.comment === true ? null : (access?.blocked ?? gt("You cannot comment here."));
  const contentMaxWidth =
    Platform.OS === "android"
      ? ANDROID_READING_MAX_WIDTH
      : layout.usesSplitView
        ? CHAT_CONTENT_MAX_WIDTH
        : undefined;
  const url = issue?.url;
  const refreshControl = (
    <RefreshControl
      refreshing={pullRefresh.refreshing}
      onRefresh={() => void pager.refresh(registry, pullRefresh.onRefresh)}
    />
  );
  const issueHeader = issue ? (
    <View className="gap-5">
      <IssueIdentity
        issue={issue}
        access={access}
        busy={busy === "state"}
        onMove={moveTo}
        onEditLabels={() => navigation.navigate("IssueLabels", identity)}
        onEditAssignees={() => navigation.navigate("IssueAssignees", identity)}
      />
      {mutationError || olderCommentsError || (detail && detailQuery.error) ? (
        <Text selectable className="text-sm text-danger-foreground">
          {mutationError ?? olderCommentsError ?? detailQuery.error}
        </Text>
      ) : null}
      {properties === undefined ? null : (
        <SegmentedControl
          options={[
            { value: "overview", label: gt("Overview") },
            { value: "properties", label: gt("Properties", { $context: "issue tab" }) },
          ]}
          selected={tab}
          onSelect={(next) => {
            Keyboard.dismiss();
            setSelectedTab(next);
          }}
          role="tab"
          size="compact"
        />
      )}
    </View>
  ) : null;
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
          subtitle={connected ? params.scope : gt("{scope} · Offline", { scope: params.scope })}
          onBack={layout.usesSplitView ? undefined : returnToList}
          menus={[
            {
              title: gt("Issue actions"),
              icon: "ellipsis",
              items: [
                ...(access?.edit
                  ? [
                      {
                        id: "edit-title",
                        title: gt("Edit title"),
                        icon: "pencil",
                        onPress: () =>
                          navigation.navigate("IssueEdit", { ...identity, field: "title" }),
                      },
                      {
                        id: "edit-description",
                        title: gt("Edit description"),
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
                        title: gt("Open on the tracker"),
                        icon: "arrow.up.right",
                        onPress: () => void tryOpenExternalUrl(url),
                      },
                      {
                        id: "copy-link",
                        title: gt("Copy link"),
                        icon: "link",
                        onPress: () => copyTextWithHaptic(url, { target: "issue link" }),
                      },
                      {
                        id: "share",
                        title: gt("Share…"),
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
        <ScreenContent>
          {!usesNativeWorkspaceColumns ? (
            <NativeLayoutObserver onChange={setScreenMetrics} />
          ) : null}
          {tab === "properties" && properties !== undefined ? (
            <IssuePropertiesView
              header={issueHeader}
              refreshControl={refreshControl}
              properties={properties}
              pins={pins.ids}
              ready={pins.ready}
              onTogglePin={pins.toggle}
            />
          ) : (
            // Not a bare marker: Android wraps a refreshable scroll view, which the marker rejects.
            <NativeScrollView
              className="flex-1"
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              refreshControl={refreshControl}
              contentContainerStyle={{
                paddingHorizontal: 16,
                paddingTop: 8,
                paddingBottom: showComposer ? composerHeight + 16 : 24,
              }}
            >
              {!issue ? (
                detailQuery.error && !detailQuery.isPending ? (
                  <EmptyState
                    title={gt("Couldn't load this issue")}
                    detail={detailQuery.error}
                    variant="plain"
                  />
                ) : (
                  <AppActivityIndicator className="my-12" colorClassName="accent-icon" />
                )
              ) : (
                <View className="gap-5">
                  {issueHeader}
                  {!detail ? (
                    detailQuery.error && !detailQuery.isPending ? (
                      <EmptyState
                        title={gt("Couldn't load this issue")}
                        detail={detailQuery.error}
                        variant="plain"
                      />
                    ) : (
                      <IssueLoadingBody />
                    )
                  ) : (
                    <>
                      {pinned.length > 0 ? (
                        <View accessibilityLabel={gt("Pinned properties")} className="gap-1">
                          {pinned.map((property) => (
                            <IssuePropertyRow
                              key={property.id}
                              property={property}
                              pinned
                              disabled={!pins.ready}
                              onTogglePin={pins.toggle}
                            />
                          ))}
                        </View>
                      ) : null}
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
                      <LinkedThreads params={params} host={detail.host} />
                      <View className="gap-3">
                        <PullRequestSectionHeading>
                          {detail.commentCount > 0
                            ? gt(
                                "{count, plural, one {Activity · {count} comment} other {Activity · {count} comments}}",
                                { count: detail.commentCount },
                              )
                            : gt("Activity")}
                        </PullRequestSectionHeading>
                        {nextCursor !== null ? (
                          <Button
                            label={loadingOlder ? gt("Loading…") : gt("Load older comments")}
                            disabled={busy !== null || !canLoadOlder}
                            onPress={() => void loadOlder()}
                          />
                        ) : null}
                        {timeline.length === 0 ? (
                          <Text className="text-sm text-foreground-muted">
                            <T>Nothing has happened here yet.</T>
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
          )}
          {showComposer ? (
            <KeyboardStickyView
              // On the unfolded Duo the sidebar's search shares the keyboard; follow it only for ours.
              enabled={deviceType !== "duo-unfolded" || composerFocused}
              pointerEvents="box-none"
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                top: 0,
                // Kept mounted on the properties tab, so a draft survives the look.
                display: tab === "overview" ? "flex" : "none",
              }}
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
        </ScreenContent>
      </View>
    </PullRequestMarkdownRepository>
  );
}
