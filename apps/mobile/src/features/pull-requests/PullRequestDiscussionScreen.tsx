import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { PullRequestMentionInput as TextInput } from "./PullRequestMentionInput";
import {
  PullRequestPermissionButton,
  PullRequestPermissionIconButton,
} from "./PullRequestPermissionButton";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useAtomValue } from "@effect/atom-react";
import { pullRequestSuggestion } from "@t3tools/shared/pullRequestSuggestion";
import {
  groupPullRequestComments,
  pullRequestThreadStatusLabels as statusLabels,
} from "@t3tools/client-runtime/pull-request-comment-replies";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { PullRequestThreadComment, PullRequestThreadStatus } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { Toolbar } from "../../components/ui/Toolbar";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { relativeTime } from "../../lib/time";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { PullRequestMarkdown, PullRequestMarkdownRepository } from "./PullRequestMarkdown";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";

export function PullRequestDiscussionScreen({
  route,
}: StaticScreenProps<PullRequestParams & { readonly discussionId: string }>) {
  return (
    <Discussion
      key={`${pullRequestReviewKey(route.params)}:${route.params.discussionId}`}
      params={route.params}
    />
  );
}

function Discussion({ params }: { params: PullRequestParams & { readonly discussionId: string } }) {
  const target = pullRequestTarget(params);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);
  const activity = useEnvironmentQuery(composerPullRequests.activity(target));
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const permissions = usePullRequestPermissions(params, detail.data);
  const nativeAllowed = useAtomValue(
    composerPullRequests.runHostAction.permissionAtom(target.environmentId),
  );
  const nativeAction = useAtomCommand(composerPullRequests.runHostAction, { reportFailure: false });
  const reply = useAtomCommand(composerPullRequests.replyToThread, { reportFailure: false });
  const resolve = useAtomCommand(composerPullRequests.setThreadResolution, {
    reportFailure: false,
  });
  const setReaction = useAtomCommand(composerPullRequests.setReaction, { reportFailure: false });
  const updateComment = useAtomCommand(composerPullRequests.updateComment, {
    reportFailure: false,
  });
  const deleteComment = useAtomCommand(composerPullRequests.deleteComment, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const loadMore = useAtomCommand(composerPullRequests.threadComments, { reportFailure: false });
  const thread = activity.data?.reviewThreads.find((thread) => thread.id === params.discussionId);
  const discussion = useMemo(
    () =>
      thread === undefined && activity.data
        ? groupPullRequestComments(activity.data).find(
            (group) => group.threadId === params.discussionId,
          )
        : undefined,
    [thread, activity.data, params.discussionId],
  );
  const [body, setBody] = useState("");
  const [extra, setExtra] = useState<readonly PullRequestThreadComment[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(64);
  const operation = async (run: () => Promise<AtomCommandResult<unknown, unknown> | undefined>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await run();
    pending.current = false;
    setBusy(false);
    if (result && AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error ? cause.message : "The provider could not complete this action.",
      );
    }
  };
  const post = (resolveAfter = false) =>
    operation(async () => {
      if (!permissions.canReply || !body.trim() || (!thread && !discussion)) return undefined;
      const submitted = body;
      const response = await reply({
        ...target,
        input: { ...target.input, threadId: params.discussionId, body: submitted },
      });
      if (AsyncResult.isFailure(response)) return response;
      setBody((current) => (current === submitted ? "" : current));
      setNotice("Reply posted.");
      if (resolveAfter && canReplyAndResolve) {
        const resolved = await resolve({
          ...target,
          input: { ...target.input, threadId: params.discussionId, resolved: true },
        });
        if (AsyncResult.isFailure(resolved)) {
          setError(
            "Your reply was posted, but the discussion could not be resolved. Use its status control to retry.",
          );
          return undefined;
        }
      }
      return response;
    });
  const toggleResolved = () =>
    operation(async () => {
      if (!thread || !permissions.canResolve) return undefined;
      const response = await resolve({
        ...target,
        input: { ...target.input, threadId: thread.id, resolved: !thread.isResolved },
      });
      return response;
    });
  const status =
    activity.data?.comments.find((comment) => comment.threadId === params.discussionId)
      ?.threadStatus ?? discussion?.comments[0]?.threadStatus;
  // The shortcut is for an open general discussion; a code thread resolves from the header.
  const canReplyAndResolve =
    permissions.canResolve &&
    !thread &&
    Boolean(discussion) &&
    (status === undefined || status === "active" || status === "pending");
  const setStatus = (status: PullRequestThreadStatus) =>
    operation(async () => {
      if (!permissions.canResolve) return undefined;
      return resolve({
        ...target,
        input: {
          ...target.input,
          threadId: params.discussionId,
          status,
          resolved: status !== "active" && status !== "pending",
        },
      });
    });
  const ownComment = (comment: PullRequestThreadComment) =>
    comment.canEdit ??
    Boolean(
      detail.data?.viewer &&
      comment.author?.login.toLowerCase() === detail.data.viewer.toLowerCase(),
    );
  const commentKind = (comment: PullRequestThreadComment): "issue-comment" | "review-comment" =>
    "kind" in comment && comment.kind === "issue-comment" ? "issue-comment" : "review-comment";
  const saveComment = (comment: PullRequestThreadComment) =>
    operation(async () => {
      if (!editing?.body.trim() || !permissions.canEditComment || !ownComment(comment))
        return undefined;
      const response = await updateComment({
        ...target,
        input: {
          ...target.input,
          commentId: comment.id,
          kind: commentKind(comment),
          body: editing.body,
        },
      });
      if (AsyncResult.isFailure(response)) return response;
      setEditing(null);
      return response;
    });
  const removeComment = (comment: PullRequestThreadComment) =>
    Dialog.alert("Delete comment?", "This removes your comment from the pull request.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void operation(async () => {
            if (!permissions.canDeleteComment || !ownComment(comment)) return undefined;
            return deleteComment({
              ...target,
              input: {
                ...target.input,
                commentId: comment.id,
                kind: commentKind(comment),
              },
            });
          }),
      },
    ]);
  const toggleLike = (comment: PullRequestThreadComment) =>
    operation(async () => {
      if (!permissions.canLikeComment) return undefined;
      const like = comment.reactions?.find((reaction) => reaction.content === "thumbs-up");
      return setReaction({
        ...target,
        input: {
          ...target.input,
          subjectId: comment.id,
          content: "thumbs-up",
          reacted: !like?.viewerHasReacted,
        },
      });
    });
  const canSuggest = (comment: PullRequestThreadComment) =>
    nativeAllowed &&
    detail.data?.provider === "azure-devops" &&
    detail.data.headSha !== undefined &&
    Boolean(thread && !thread.isResolved) &&
    pullRequestSuggestion(comment.body) !== null;
  const applySuggestion = (comment: PullRequestThreadComment) =>
    Dialog.alert(
      "Apply suggestion?",
      `Commit the suggested code to the source branch of PR #${params.number}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Apply",
          onPress: () =>
            void operation(async () => {
              if (!canSuggest(comment) || !detail.data?.headSha) return undefined;
              const result = await nativeAction({
                ...target,
                input: {
                  ...target.input,
                  action: {
                    type: "apply-suggestion",
                    commentId: comment.id,
                    expectedHead: detail.data.headSha,
                  },
                },
              });
              if (AsyncResult.isFailure(result)) return result;
              setNotice(result.value.message);
              return result;
            }),
        },
      ],
    );
  const commentActions = (comment: PullRequestThreadComment) => [
    ...(comment.url
      ? [
          { id: "copy-link", title: "Copy link" },
          { id: "open", title: "Open on host" },
        ]
      : []),
    { id: "copy-text", title: "Copy text" },
    ...(canSuggest(comment) ? [{ id: "apply-suggestion", title: "Apply suggestion" }] : []),
  ];
  const onCommentAction = (comment: PullRequestThreadComment, action: string) => {
    if (action === "copy-link" && comment.url)
      copyTextWithHaptic(comment.url, { target: "comment link" });
    if (action === "copy-text") copyTextWithHaptic(comment.body, { target: "comment text" });
    if (action === "open" && comment.url) void Linking.openURL(comment.url);
    if (action === "apply-suggestion") applySuggestion(comment);
  };
  const renderCommentActions = (comment: PullRequestThreadComment) => {
    const like = comment.reactions?.find((reaction) => reaction.content === "thumbs-up");
    return (
      <View className="flex-row items-center justify-end gap-1">
        {permissions.canLikeComment ? (
          <View className="flex-row items-center">
            <PullRequestPermissionIconButton
              reason={detail.data?.viewerPermissions.deniedActions?.["like-comment"]}
              accessibilityLabel={like?.viewerHasReacted ? "Unlike comment" : "Like comment"}
              icon="hand.thumbsup"
              selected={like?.viewerHasReacted === true}
              variant={like?.viewerHasReacted ? "tonal" : "standard"}
              disabled={busy}
              onPress={() => void toggleLike(comment)}
            />
            {like && like.count > 0 ? (
              <Text className="text-xs text-foreground-muted">{like.count}</Text>
            ) : null}
          </View>
        ) : like && like.count > 0 ? (
          <Text className="text-xs text-foreground-muted">👍 {like.count}</Text>
        ) : null}
        {ownComment(comment) && permissions.canEditComment ? (
          <PullRequestPermissionIconButton
            reason={detail.data?.viewerPermissions.deniedActions?.["edit-comment"]}
            accessibilityLabel="Edit comment"
            icon="pencil"
            disabled={busy}
            onPress={() => setEditing({ id: comment.id, body: comment.body })}
          />
        ) : null}
        {ownComment(comment) && permissions.canDeleteComment ? (
          <PullRequestPermissionIconButton
            reason={detail.data?.viewerPermissions.deniedActions?.["delete-comment"]}
            accessibilityLabel="Delete comment"
            icon="trash"
            disabled={busy}
            tintColorClassName="accent-danger-foreground"
            onPress={() => removeComment(comment)}
          />
        ) : null}
        <Menu
          title="Comment actions"
          actions={commentActions(comment)}
          onPressAction={({ nativeEvent }) => onCommentAction(comment, nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Comment actions"
            disabled={busy}
            className="min-h-11 min-w-11 items-center justify-center"
          >
            <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </Menu>
      </View>
    );
  };
  const nextCursor = cursor === undefined ? thread?.nextCommentsCursor : cursor;
  const more = () =>
    operation(async () => {
      if (!thread || !nextCursor) return undefined;
      const response = await loadMore({
        ...target,
        input: { ...target.input, threadId: thread.id, cursor: nextCursor },
      });
      if (AsyncResult.isFailure(response)) return response;
      setExtra((comments) => [...comments, ...response.value.comments]);
      setCursor(response.value.nextCursor);
      return response;
    });
  const comments = [
    ...new Map(
      [...extra, ...(thread?.comments ?? discussion?.comments ?? [])].map((comment) => [
        comment.id,
        comment,
      ]),
    ).values(),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const canReply = permissions.canReply && Boolean(thread || discussion);
  const resolveLabel = thread?.isResolved ? "Unresolve" : "Resolve";
  return (
    <PullRequestMarkdownRepository
      params={params}
      value={
        detail.data?.provider === "github" || detail.data?.provider === "azure-devops"
          ? detail.data.url
          : null
      }
    >
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
        <NativeStackScreenOptions
          options={{ title: "Discussion", unstable_headerSubtitle: `#${params.number}` }}
        />
        {Platform.OS === "android" ? (
          <AndroidScreenHeader
            title="Discussion"
            subtitle={`#${params.number}`}
            onBack={() => navigation.goBack()}
            actions={
              permissions.canResolve && thread
                ? [
                    {
                      accessibilityLabel: resolveLabel,
                      icon: thread.isResolved ? "arrow.uturn.backward" : "checkmark",
                      disabled: busy || activity.isPending,
                      onPress: () => void toggleResolved(),
                    },
                  ]
                : []
            }
          />
        ) : null}
        {permissions.canResolve && thread ? (
          <Toolbar placement="right">
            <Toolbar.Button
              label={resolveLabel}
              disabled={busy || activity.isPending}
              onPress={() => void toggleResolved()}
            />
          </Toolbar>
        ) : null}
        <ScrollViewMarker style={{ flex: 1 }}>
          <ScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              padding: 20,
              paddingBottom: canReply ? composerHeight + bottomInset + 24 : 24,
            }}
          >
            {activity.isPending && !thread && !discussion ? <AppActivityIndicator /> : null}
            {thread ? (
              <View className="gap-2 pb-4">
                <Text selectable className="font-mono text-xs text-foreground-muted">
                  {thread.path}
                  {thread.line
                    ? `:${thread.line}${thread.endLine && thread.endLine !== thread.line ? `–${thread.endLine}` : ""}`
                    : ""}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {thread.isResolved ? "Resolved" : "Unresolved"}
                  {thread.isOutdated ? " · Outdated" : ""}
                </Text>
                <Button
                  label="View file diff"
                  onPress={() =>
                    navigation.navigate("PullRequestFile", { ...params, path: thread.path })
                  }
                />
              </View>
            ) : !discussion && !activity.isPending ? (
              <Text>This discussion is no longer available.</Text>
            ) : null}
            {status ? (
              <View className="gap-2 pb-4">
                <Text className="text-xs text-foreground-muted">
                  Status: {statusLabels[status]}
                </Text>
                {permissions.canResolve && detail.data?.capabilities.review.threadStatuses ? (
                  <Menu
                    title="Discussion status"
                    actions={detail.data.capabilities.review.threadStatuses.map((value) => ({
                      id: value,
                      title: detail.data?.viewerPermissions.deniedActions?.resolve
                        ? `${statusLabels[value]} — ${detail.data.viewerPermissions.deniedActions.resolve}`
                        : statusLabels[value],
                      state: value === status ? "on" : "off",
                      attributes: {
                        disabled:
                          busy || Boolean(detail.data?.viewerPermissions.deniedActions?.resolve),
                      },
                    }))}
                    onPressAction={({ nativeEvent }) => {
                      const next = detail.data?.capabilities.review.threadStatuses?.find(
                        (value) => value === nativeEvent.event,
                      );
                      if (next) void setStatus(next);
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Change discussion status"
                      disabled={busy}
                      className="min-h-11 justify-center"
                    >
                      <Text className="text-primary-text">Change status</Text>
                    </Pressable>
                  </Menu>
                ) : null}
              </View>
            ) : null}
            {comments.map((comment) => (
              <View key={comment.id} className="gap-3 border-b border-border-subtle py-4">
                <View className="flex-row items-center gap-2">
                  <PullRequestAvatar actor={comment.author} size={28} />
                  <Text className="min-w-0 flex-1 text-sm font-t3-medium">
                    {comment.author?.login ?? "Unknown author"}
                  </Text>
                  <Text className="text-2xs text-foreground-muted">
                    {relativeTime(comment.createdAt)}
                  </Text>
                </View>
                {editing?.id === comment.id ? (
                  <View className="gap-2">
                    <TextInput
                      params={params}
                      accessibilityLabel="Edit comment"
                      multiline
                      maxLength={65536}
                      editable={!busy}
                      value={editing.body}
                      onChangeText={(body) => setEditing({ id: comment.id, body })}
                      className="min-h-24 rounded-xl border border-border-subtle p-3 text-foreground"
                    />
                    <View className="flex-row gap-2">
                      <Button
                        label="Save comment"
                        disabled={busy || !editing.body.trim()}
                        onPress={() => void saveComment(comment)}
                      />
                      <Button label="Cancel" disabled={busy} onPress={() => setEditing(null)} />
                    </View>
                  </View>
                ) : (
                  <PullRequestMarkdown markdown={comment.body} />
                )}
                {renderCommentActions(comment)}
              </View>
            ))}
            {nextCursor ? (
              <Button
                label={busy ? "Loading…" : "Load more replies"}
                disabled={busy}
                onPress={() => void more()}
              />
            ) : null}
            {error || activity.error ? (
              <Text selectable className="py-4 text-sm text-danger-foreground">
                {error ?? activity.error}
              </Text>
            ) : null}
            {notice ? <Text className="py-4 text-sm text-foreground-muted">{notice}</Text> : null}
          </ScrollView>
        </ScrollViewMarker>
        {canReply ? (
          <View className="absolute inset-x-4 bottom-0" style={{ paddingBottom: bottomInset }}>
            <GlassSurface
              chrome="none"
              onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
              className="flex-row items-end gap-1 p-1"
            >
              <TextInput
                params={params}
                accessibilityLabel="Discussion reply"
                multiline
                maxLength={65536}
                placeholder="Reply…"
                placeholderTextColorClassName="accent-foreground-muted"
                value={body}
                onChangeText={setBody}
                editable={!busy}
                className="max-h-36 min-h-12 min-w-0 flex-1 rounded-[24px] border-0 bg-transparent px-4 py-3 text-base text-foreground"
              />
              <View>
                {canReplyAndResolve ? (
                  <PullRequestPermissionButton
                    reason={
                      detail.data?.viewerPermissions.deniedActions?.comment ??
                      detail.data?.viewerPermissions.deniedActions?.resolve
                    }
                    label="Reply & resolve"
                    disabled={busy || !body.trim()}
                    onPress={() => void post(true)}
                  />
                ) : null}
                <PullRequestPermissionButton
                  reason={detail.data?.viewerPermissions.deniedActions?.comment}
                  label={busy ? "Posting…" : "Reply"}
                  tone="contrast"
                  disabled={busy || !body.trim()}
                  onPress={() => void post()}
                />
              </View>
            </GlassSurface>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </PullRequestMarkdownRepository>
  );
}
