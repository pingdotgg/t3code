import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  resolvePullRequestReviewAnchor,
} from "@t3tools/shared/pullRequestAnchor";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useAtomRefresh } from "@effect/atom-react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { pullRequestConversationThreads, type PullRequestThreadComment } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { ScrollView, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { compareTimestamps, relativeTime } from "../../lib/time";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { PullRequestMarkdown, PullRequestMarkdownRepository } from "./PullRequestMarkdown";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { PullRequestCommentFooter } from "./PullRequestReactions";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";
import { PullRequestCompletionSuggestions } from "./PullRequestCompletionSuggestions";
import { usePullRequestCompletions } from "./usePullRequestCompletions";

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
  const refresh = useAtomRefresh(composerPullRequests.activity(target));
  const reply = useAtomCommand(composerPullRequests.replyToThread, { reportFailure: false });
  const resolve = useAtomCommand(composerPullRequests.setThreadResolution, {
    reportFailure: false,
  });
  const loadMore = useAtomCommand(composerPullRequests.threadComments, { reportFailure: false });
  const thread =
    activity.data &&
    pullRequestConversationThreads(activity.data).find(
      (thread) => thread.id === params.discussionId,
    );
  const filePath = thread?.path ?? null;
  const [body, setBody] = useState("");
  const completions = usePullRequestCompletions({
    environmentId: params.environmentId,
    projectId: params.projectId,
    value: body,
    onChangeValue: setBody,
    support: detail.data?.capabilities ?? null,
  });
  const [extra, setExtra] = useState<readonly PullRequestThreadComment[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(64);
  // Replies from "Load more" live only here, outside the activity an edit refreshes. After one
  // is edited, drop the loaded pages so the next load reads the new body instead of the old one.
  const extraEdited = useRef(false);
  useFocusEffect(() => {
    if (!extraEdited.current) return;
    extraEdited.current = false;
    setExtra([]);
    setCursor(undefined);
  });
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
  const post = () =>
    operation(async () => {
      if (!permissions.canReply || !body.trim() || !thread) return undefined;
      const submitted = body;
      const response = await reply({
        ...target,
        input: { ...target.input, threadId: thread.id, body: submitted },
      });
      if (AsyncResult.isFailure(response)) return response;
      setBody((current) => (current === submitted ? "" : current));
      setNotice("Reply posted.");
      refresh();
      return response;
    });
  const toggleResolved = () =>
    operation(async () => {
      if (!thread || !permissions.canResolve) return undefined;
      const response = await resolve({
        ...target,
        input: { ...target.input, threadId: thread.id, resolved: !thread.isResolved },
      });
      if (AsyncResult.isSuccess(response)) refresh();
      return response;
    });
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
      [...extra, ...(thread?.comments ?? [])].map((comment) => [comment.id, comment]),
    ).values(),
  ].sort((left, right) => compareTimestamps(left.createdAt, right.createdAt));
  const scrollRef = useRef<ScrollViewInstance>(null);
  const pendingTop = useRef<number | null>(null);
  const positionedComment = useRef<string | null>(null);
  const location = parsePullRequestAnchor(params.navigationUrl);
  const anchor =
    location?.kind === "timeline"
      ? resolvePullRequestReviewAnchor(location.anchor, [], [{ comments }])
      : null;
  const canReply = permissions.canReply && Boolean(thread);
  const resolveLabel = thread?.isResolved ? "Unresolve" : "Resolve";
  return (
    <PullRequestMarkdownRepository params={params} changeRequest={detail.data}>
      <KeyboardAvoidingView
        automaticOffset
        behavior="height"
        className="flex-1 bg-screen"
        // Any touch, such as replying or loading replies, ends the wait to reposition the link.
        onTouchStart={() => {
          pendingTop.current = null;
        }}
      >
        <AppBar
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
        <ScrollViewMarker style={{ flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            onContentSizeChange={() => {
              if (pendingTop.current === null) return;
              scrollRef.current?.scrollTo({ y: pendingTop.current, animated: false });
              pendingTop.current = null;
            }}
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              padding: 20,
              paddingBottom: canReply ? composerHeight + bottomInset + 24 : 24,
            }}
          >
            {activity.isPending && !thread ? <AppActivityIndicator /> : null}
            {thread ? (
              <View className="gap-2 pb-4">
                {thread.path === null ? null : (
                  <Text selectable className="font-mono text-xs text-foreground-muted">
                    {thread.path}
                    {thread.line ? `:${thread.line}` : ""}
                  </Text>
                )}
                <Text className="text-xs text-foreground-muted">
                  {thread.isResolved ? "Resolved" : "Unresolved"}
                  {thread.isOutdated ? " · Outdated" : ""}
                </Text>
                {filePath === null ? null : (
                  <Button
                    label="View file diff"
                    onPress={() =>
                      navigation.navigate("PullRequestFile", { ...params, path: filePath })
                    }
                  />
                )}
              </View>
            ) : !activity.isPending ? (
              <Text>This discussion is no longer available.</Text>
            ) : null}
            {comments.map((comment) => (
              <View
                key={comment.id}
                onLayout={(event) => {
                  if (
                    anchor === null ||
                    !pullRequestAnchorMatchesUrl(anchor, comment.url) ||
                    positionedComment.current === comment.id
                  )
                    return;
                  positionedComment.current = comment.id;
                  pendingTop.current = event.nativeEvent.layout.y;
                  scrollRef.current?.scrollTo({ y: pendingTop.current, animated: false });
                }}
                className={
                  anchor !== null && pullRequestAnchorMatchesUrl(anchor, comment.url)
                    ? "-mx-3 gap-3 rounded-2xl border border-primary bg-primary/10 px-3 py-4"
                    : "gap-3 border-b border-border-subtle py-4"
                }
              >
                <View className="flex-row items-center gap-2">
                  <PullRequestAvatar actor={comment.author} size={28} />
                  <Text className="min-w-0 flex-1 text-sm font-t3-medium">
                    {comment.author?.login ?? "Unknown author"}
                  </Text>
                  <Text className="text-2xs text-foreground-muted">
                    {relativeTime(comment.createdAt)}
                  </Text>
                </View>
                <PullRequestMarkdown markdown={comment.body} />
                <PullRequestCommentFooter
                  params={params}
                  comment={{ ...comment, kind: "review-comment" }}
                  permissions={permissions}
                  onChanged={refresh}
                  onEdit={() => {
                    if (extra.some((loaded) => loaded.id === comment.id))
                      extraEdited.current = true;
                  }}
                />
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
          <View
            className="absolute inset-x-4 bottom-0 gap-2"
            style={{ paddingBottom: bottomInset }}
          >
            <PullRequestCompletionSuggestions completions={completions} />
            <GlassSurface
              chrome="none"
              onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
              className="flex-row items-end gap-1 p-1"
            >
              <TextInput
                accessibilityLabel="Discussion reply"
                selection={completions.selection}
                onSelectionChange={completions.onSelectionChange}
                onBlur={completions.onBlur}
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
                <Button
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
