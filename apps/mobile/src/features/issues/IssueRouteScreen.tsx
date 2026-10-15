import { RegistryContext } from "@effect/atom-react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type IssueComment,
  type IssueDetail,
  type IssueEvent,
  type IssueLinkedPullRequest,
  type IssueReactionContent,
} from "@t3tools/contracts";
import { use, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { EmptyState } from "../../components/EmptyState";
import { MaterialButton } from "../../components/MaterialButton";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useProject, useProjects, useServerConfigs } from "../../state/entities";
import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import { PullRequestCardGroup, PullRequestCardRow } from "../pull-requests/PullRequestControls";
import { PullRequestMarkdown } from "../pull-requests/PullRequestMarkdown";
import { PullRequestMediaContext } from "../pull-requests/PullRequestMedia";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";
import { issueReactionAllowed, issueTimeline, linkedPullRequestContext } from "./issueDetail";
import {
  appendOlderIssueComments,
  issueCommentsView,
  confirmIssueReaction,
  issueReactionsView,
  type IssueConfirmedReactions,
  type IssueOlderComments,
} from "./issueComments";
import { IssueReactions } from "./IssueReactions";
import { issueParamsKey, type IssueParams } from "./issueSelection";
import { issueStatus } from "./issueStatus";
import { issueTarget, markIssueTargetWritten, useIssueAccess } from "./useIssueAccess";

function linkedPullRequestStatus(link: IssueLinkedPullRequest) {
  return link.state === null
    ? ({ label: "Unknown", icon: "arrow.triangle.pull", tint: "accent-icon-muted" } as const)
    : pullRequestStatus({ state: link.state, isDraft: link.isDraft });
}

function LinkedPullRequestRow(props: {
  readonly link: IssueLinkedPullRequest;
  readonly environmentId: string;
  readonly last: boolean;
}) {
  const { link } = props;
  const projects = useProjects();
  const configs = useServerConfigs();
  const context = linkedPullRequestContext(
    link.url,
    props.environmentId,
    projects,
    configs.get(EnvironmentId.make(props.environmentId))?.environment.capabilities,
  );
  const openPullRequest = useOpenPullRequest(context ? { context } : undefined);
  const linkStatus = linkedPullRequestStatus(link);
  return (
    <PullRequestCardRow
      title={link.title}
      icon={linkStatus.icon}
      tint={linkStatus.tint}
      detail={`${link.repository}#${link.number}${link.closesIssue ? " · closes this issue" : ""}`}
      accessibilityLabel={`Pull request ${link.number}, ${link.title}, ${linkStatus.label}`}
      last={props.last}
      onPress={() =>
        void (context ? openPullRequest(link.url) : tryOpenExternalUrl(link.url, "pull-request"))
      }
    />
  );
}

function IssueEventRow({ event }: { readonly event: IssueEvent }) {
  const verb: Record<IssueEvent["kind"], string> = {
    closed: "closed this",
    reopened: "reopened this",
    labeled: "added",
    unlabeled: "removed",
    assigned: "assigned",
    unassigned: "unassigned",
    renamed: "renamed this to",
    referenced: "referenced this in",
    "state-changed": "moved this to",
  };
  return (
    <View className="flex-row items-center gap-2 px-1">
      <SymbolView name="circle" size={8} tintColorClassName="accent-icon-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={2}>
        <Text className="font-t3-medium text-foreground">{event.actor?.login ?? "Someone"}</Text>{" "}
        {verb[event.kind]}
        {event.detail ? ` ${event.detail}` : ""}
      </Text>
      <Text className="text-2xs text-foreground-tertiary">{relativeTime(event.createdAt)}</Text>
    </View>
  );
}

function IssueCommentCard(props: {
  readonly comment: IssueComment;
  readonly busy: boolean;
  readonly reactionContents: ReadonlyArray<IssueReactionContent> | undefined;
  readonly onReact: ((content: IssueReactionContent, reacted: boolean) => void) | undefined;
}) {
  const { comment } = props;
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <PullRequestAvatar actor={comment.author} size={22} />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
          {comment.author?.login ?? "Unknown author"}
        </Text>
        <Text className="text-2xs text-foreground-tertiary">{relativeTime(comment.createdAt)}</Text>
      </View>
      <View className="gap-2 rounded-2xl bg-grouped-card p-3">
        {comment.body.trim() ? <PullRequestMarkdown markdown={comment.body} /> : null}
        <IssueReactions
          reactions={comment.reactions}
          contents={props.reactionContents}
          busy={props.busy}
          onToggle={props.onReact}
        />
      </View>
    </View>
  );
}

function IssueBody(props: { readonly params: IssueParams; readonly issue: IssueDetail }) {
  const { issue, params } = props;
  const navigation = useNavigation();
  const registry = use(RegistryContext);
  const target = issueTarget(params);
  const access = useIssueAccess(params, issue);
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const react = useAtomCommand(issueEnvironment.react, { reportFailure: false });
  const loadComments = useAtomCommand(issueEnvironment.comments, { reportFailure: false });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [older, setOlder] = useState<IssueOlderComments | null>(null);
  const { comments, cursor } = issueCommentsView(issue, older);
  const [confirmed, setConfirmed] = useState<IssueConfirmedReactions | null>(null);
  const reactionView = issueReactionsView(target.environmentId, issue, comments, confirmed);
  if (confirmed !== reactionView.held) setConfirmed(reactionView.held);
  const reactionTarget = useRef({ issue, access, comments });
  useLayoutEffect(() => {
    reactionTarget.current = { issue, access, comments };
  });
  const run = async (work: () => Promise<void>, failure: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      Alert.alert(failure, cause instanceof Error ? cause.message : "Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const changeState = (state: string, closeReason?: string) =>
    run(async () => {
      const response = await setState({
        ...target,
        input: { ...target.input, state, ...(closeReason ? { closeReason } : {}) },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      markIssueTargetWritten(registry, params);
    }, "Couldn't change this issue's state");
  const toggleReaction =
    (subjectId?: string) => (content: IssueReactionContent, reacted: boolean) => {
      const current = reactionTarget.current;
      if (
        !issueReactionAllowed(current.issue, current.access, content, subjectId, current.comments)
      )
        return;
      return run(async () => {
        const response = await react({
          ...target,
          input: { ...target.input, ...(subjectId ? { subjectId } : {}), content, reacted },
        });
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        setConfirmed((current) =>
          confirmIssueReaction(
            target.environmentId,
            issue,
            comments,
            current,
            content,
            reacted,
            subjectId,
          ),
        );
      }, "Couldn't update this reaction");
    };
  const loadOlder = () =>
    run(async () => {
      if (!cursor) return;
      const response = await loadComments({
        ...target,
        input: {
          ...target.input,
          cursor,
          ...(issue.viewer === null ? {} : { viewer: issue.viewer }),
        },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      setOlder((current) => appendOlderIssueComments(issue, current, response.value));
    }, "Couldn't load older comments");
  const status = issueStatus(issue.state);
  const stateActions = access.states.map((state) => ({
    id: JSON.stringify([state.name, ""]),
    title: state.name,
    ...(state.category === "closed" && access.closeReasons.length
      ? {
          subactions: access.closeReasons.map((reason) => ({
            id: JSON.stringify([state.name, reason]),
            title: reason,
          })),
        }
      : {}),
  }));
  const trigger = (
    <Pressable
      accessibilityRole={stateActions.length ? "button" : undefined}
      accessibilityLabel={`Issue state, ${status.label}`}
      disabled={!stateActions.length || busy}
      className="min-h-8 flex-row items-center gap-1.5 active:opacity-70"
    >
      <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
      <Text className={`text-xs font-t3-medium ${status.text}`}>{status.label}</Text>
      {issue.state.closeReason ? (
        <Text className="text-2xs text-foreground-muted">· {issue.state.closeReason}</Text>
      ) : null}
      {stateActions.length ? (
        <SymbolView name="chevron.down" size={9} tintColorClassName="accent-icon-muted" />
      ) : null}
    </Pressable>
  );
  const timeline = issueTimeline(reactionView.comments, issue.events);
  return (
    <View className="gap-5">
      <View className="gap-3">
        <View className="flex-row flex-wrap items-center gap-2">
          {stateActions.length ? (
            <ControlPillMenu
              title="Issue state"
              actions={stateActions}
              onPressAction={({ nativeEvent }) => {
                let selection: unknown;
                try {
                  selection = JSON.parse(nativeEvent.event);
                } catch {
                  return;
                }
                if (!Array.isArray(selection) || typeof selection[0] !== "string") return;
                const [state, reason] = selection as [string, string];
                if (!access.states.some((each) => each.name === state)) return;
                void changeState(state, reason || undefined);
              }}
            >
              {trigger}
            </ControlPillMenu>
          ) : (
            trigger
          )}
          {busy ? <ActivityIndicator size="small" /> : null}
          {!issue.writable ? (
            <Text className="text-2xs text-foreground-muted">Read-only here</Text>
          ) : null}
        </View>
        <Text selectable className="text-xl font-t3-bold leading-7">
          {issue.title}
        </Text>
        <View className="flex-row items-center gap-2">
          <PullRequestAvatar actor={issue.author} size={20} />
          <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>
            {issue.author?.login ?? "Unknown author"}
          </Text>
          <Text className="shrink text-right text-2xs text-foreground-muted" numberOfLines={1}>
            Updated {relativeTime(issue.updatedAt)} ago
          </Text>
        </View>
      </View>
      <PullRequestCardGroup>
        <PullRequestCardRow
          title="Assignees"
          icon="person.2"
          compact
          value={issue.assignees.map((actor) => actor.name ?? actor.login).join(", ") || "No one"}
          onPress={
            access.assignees
              ? () => navigation.navigate("IssueCandidates", { ...params, kind: "assignees" })
              : undefined
          }
        />
        <PullRequestCardRow
          title="Labels"
          icon="ticket"
          compact
          last={!issue.linkedPullRequests.length}
          value={
            issue.labels.length
              ? `${issue.labels.map((label) => label.name).join(", ")}${issue.labelsTruncated ? "…" : ""}`
              : "None"
          }
          onPress={
            access.labels
              ? () => navigation.navigate("IssueCandidates", { ...params, kind: "labels" })
              : undefined
          }
        />
        {issue.linkedPullRequests.map((link, index) => (
          <LinkedPullRequestRow
            key={link.url}
            link={link}
            environmentId={params.environmentId}
            last={index === issue.linkedPullRequests.length - 1}
          />
        ))}
      </PullRequestCardGroup>
      {issue.body.trim() ? (
        <PullRequestMarkdown markdown={issue.body} />
      ) : (
        <Text className="text-sm text-foreground-muted">No description.</Text>
      )}
      <IssueReactions
        reactions={reactionView.reactions}
        contents={issue.capabilities.reactionContents}
        busy={busy}
        onToggle={access.react ? toggleReaction() : undefined}
      />
      <View className="gap-4">
        {cursor ? (
          <MaterialButton
            label="Load older comments"
            tone="text"
            loading={busy}
            disabled={busy}
            onPress={() => void loadOlder()}
          />
        ) : null}
        {issue.historyTruncated ? (
          <Text className="text-2xs text-foreground-muted">Older history is on the tracker.</Text>
        ) : null}
        {timeline.map((item) =>
          item.kind === "comment" ? (
            <IssueCommentCard
              key={`comment:${item.comment.id}`}
              comment={item.comment}
              busy={busy}
              reactionContents={issue.capabilities.reactionContents}
              onReact={
                access.commentReact && item.comment.reactions !== undefined
                  ? toggleReaction(item.comment.id)
                  : undefined
              }
            />
          ) : (
            <IssueEventRow key={`event:${item.event.id}`} event={item.event} />
          ),
        )}
      </View>
    </View>
  );
}

export function IssueRouteScreen({ route }: StaticScreenProps<IssueParams>) {
  const returnToList = useAndroidWorkspaceBack("issues");
  try {
    issueParamsKey(route.params);
  } catch {
    return (
      <EmptyState
        title="Couldn't open this issue"
        detail="This link is incomplete or invalid."
        variant="plain"
        actionLabel="Back to issues"
        onAction={returnToList}
      />
    );
  }
  return <IssueRouteContent params={route.params} returnToList={returnToList} />;
}

function IssueRouteContent({
  params,
  returnToList,
}: {
  readonly params: IssueParams;
  readonly returnToList: () => void;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = issueTarget(params);
  const detailAtom = issueEnvironment.detail(target);
  const result = useEnvironmentQuery(detailAtom);
  const pullRefresh = usePullToRefresh(detailAtom);
  const { refresh } = result;
  useFocusEffect(useCallback(() => refresh(), [refresh]));
  const issue = result.data;
  const access = useIssueAccess(params, issue);
  const cwd = useProject({
    environmentId: target.environmentId,
    projectId: target.input.projectId,
  })?.workspaceRoot;
  const media = useMemo(
    () => (cwd ? { environmentId: target.environmentId, cwd } : null),
    [target.environmentId, cwd],
  );
  const title = issue?.displayKey ?? params.displayKey ?? params.key;
  const subtitle = access.connected ? params.scope : `${params.scope} · Offline`;
  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      <NativeStackScreenOptions
        options={{ title, headerTitle: title, unstable_headerSubtitle: subtitle }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          subtitle={subtitle}
          onBack={layout.usesSplitView ? undefined : returnToList}
          leading={layout.usesSplitView ? <AndroidWorkspaceSidebarButton /> : undefined}
          actions={[
            ...(access.comment
              ? [
                  {
                    accessibilityLabel: "Add comment",
                    icon: "plus.bubble" as const,
                    onPress: () =>
                      navigation.navigate("IssueCompose", { ...params, mode: "comment" }),
                  },
                ]
              : []),
            ...(access.edit
              ? [
                  {
                    accessibilityLabel: "Edit issue",
                    icon: "pencil" as const,
                    onPress: () => navigation.navigate("IssueCompose", { ...params, mode: "edit" }),
                  },
                ]
              : []),
            ...(issue
              ? [
                  {
                    accessibilityLabel: "Open in browser",
                    icon: "arrow.up.right" as const,
                    onPress: () => void Linking.openURL(issue.url),
                  },
                ]
              : []),
          ]}
        />
      ) : null}
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Menu title="Issue" accessibilityLabel="Issue actions" icon="ellipsis">
          {access.comment ? (
            <NativeHeaderToolbar.MenuAction
              icon="plus.bubble"
              onPress={() => navigation.navigate("IssueCompose", { ...params, mode: "comment" })}
            >
              <NativeHeaderToolbar.Label>Add comment</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
          {access.edit ? (
            <NativeHeaderToolbar.MenuAction
              icon="pencil"
              onPress={() => navigation.navigate("IssueCompose", { ...params, mode: "edit" })}
            >
              <NativeHeaderToolbar.Label>Edit issue</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
          {issue ? (
            <NativeHeaderToolbar.MenuAction
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(issue.url)}
            >
              <NativeHeaderToolbar.Label>Open in browser</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
      <ScrollView
        className={
          Platform.OS === "android"
            ? "flex-1 overflow-hidden rounded-t-[28px] bg-sheet-solid"
            : "flex-1"
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16) + 16 }}
        refreshControl={
          <RefreshControl refreshing={pullRefresh.refreshing} onRefresh={pullRefresh.onRefresh} />
        }
      >
        {issue && result.error ? (
          <View className="mb-4 gap-2">
            <Text selectable className="text-sm text-danger-foreground">
              Couldn't refresh this issue: {result.error}
            </Text>
            <MaterialButton label="Retry" loading={result.isPending} onPress={refresh} />
          </View>
        ) : null}
        {issue ? (
          <PullRequestMediaContext value={media}>
            <IssueBody key={JSON.stringify(target)} params={params} issue={issue} />
          </PullRequestMediaContext>
        ) : result.isPending ? (
          <ActivityIndicator className="my-12" />
        ) : (
          <EmptyState
            title="Couldn't load this issue"
            detail={result.error ?? "Try again."}
            variant="plain"
            actionLabel="Retry"
            onAction={refresh}
            action={
              params.originalURL && /^https?:\/\//i.test(params.originalURL) ? (
                <View className="items-center gap-2">
                  <MaterialButton label="Retry" tone="primary" onPress={refresh} />
                  <MaterialButton
                    label="Open in browser"
                    tone="text"
                    onPress={() => void tryOpenExternalUrl(params.originalURL!, "markdown-link")}
                  />
                </View>
              ) : undefined
            }
          />
        )}
      </ScrollView>
    </View>
  );
}
