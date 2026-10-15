import { Toolbar } from "../../components/ui/Toolbar";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useAtomRefresh } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestThreadComment } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { Button } from "../../components/ui/Button";
import { GlassSurface } from "../../components/ui/GlassSurface";
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
  const refresh = useAtomRefresh(composerPullRequests.activity(target));
  const reply = useAtomCommand(composerPullRequests.replyToThread, { reportFailure: false });
  const resolve = useAtomCommand(composerPullRequests.setThreadResolution, {
    reportFailure: false,
  });
  const loadMore = useAtomCommand(composerPullRequests.threadComments, { reportFailure: false });
  const thread = activity.data?.reviewThreads.find((thread) => thread.id === params.discussionId);
  const [body, setBody] = useState("");
  const [extra, setExtra] = useState<readonly PullRequestThreadComment[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(64);
  const operation = async (run: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The provider could not complete this action.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const post = () =>
    operation(async () => {
      if (!permissions.canReply || !body.trim() || !thread) return;
      const submitted = body;
      const response = await reply({
        ...target,
        input: { ...target.input, threadId: thread.id, body: submitted },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      setBody((current) => (current === submitted ? "" : current));
      setNotice("Reply posted.");
      refresh();
    });
  const toggleResolved = () =>
    operation(async () => {
      if (!thread || !permissions.canResolve) return;
      const response = await resolve({
        ...target,
        input: { ...target.input, threadId: thread.id, resolved: !thread.isResolved },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      refresh();
    });
  const nextCursor = cursor === undefined ? thread?.nextCommentsCursor : cursor;
  const more = () =>
    operation(async () => {
      if (!thread || !nextCursor) return;
      const response = await loadMore({
        ...target,
        input: { ...target.input, threadId: thread.id, cursor: nextCursor },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      setExtra((comments) => [...comments, ...response.value.comments]);
      setCursor(response.value.nextCursor);
    });
  const comments = [
    ...new Map(
      [...extra, ...(thread?.comments ?? [])].map((comment) => [comment.id, comment]),
    ).values(),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const canReply = permissions.canReply && Boolean(thread);
  const resolveLabel = thread?.isResolved ? "Unresolve" : "Resolve";
  return (
    <PullRequestMarkdownRepository
      params={params}
      value={detail.data?.provider === "github" ? detail.data.url : null}
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
            {activity.isPending && !thread ? <AppActivityIndicator /> : null}
            {thread ? (
              <View className="gap-2 pb-4">
                <Text selectable className="font-mono text-xs text-foreground-muted">
                  {thread.path}
                  {thread.line ? `:${thread.line}` : ""}
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
            ) : !activity.isPending ? (
              <Text>This discussion is no longer available.</Text>
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
                <PullRequestMarkdown markdown={comment.body} />
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
