import { PullRequestCommentComposer } from "./PullRequestCommentComposer";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { Alert, View } from "react-native";
import type { PullRequestReviewPosition } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { uuidv4 } from "../../lib/uuid";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { PullRequestSheetContent } from "./PullRequestSheetContent";
import { setReviewDraftBusy, usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { reviewPositionLabel } from "./pullRequestDiffComments";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { usePendingReviewCommentActions } from "./usePendingReviewCommentActions";
import {
  PullRequestPendingBadge,
  PullRequestPendingCommentActions,
} from "./PullRequestPendingComment";

export type InlineCommentParams = PullRequestParams & {
  readonly draftId?: string;
  readonly path: string;
  readonly oldPath?: string;
  readonly position: PullRequestReviewPosition;
  readonly headSha: string;
  readonly code: string;
  readonly body?: string;
};
export function PullRequestInlineCommentScreen({ route }: StaticScreenProps<InlineCommentParams>) {
  const params = route.params;
  const navigation = useNavigation();
  const store = usePullRequestReviewDraft(params);
  const [commentId] = useState(() => params.draftId ?? uuidv4());
  const saved = store.comments.find((draft) => draft.id === commentId);
  const [editedBody, setBody] = useState<string | null>(null);
  const body = editedBody ?? saved?.body ?? params.body ?? "";
  const pendingActions = usePendingReviewCommentActions(params);
  const updateComment = useAtomCommand(composerPullRequests.updateComment, {
    reportFailure: false,
  });
  const saveDraftComment = useAtomCommand(composerPullRequests.saveDraftComment, {
    reportFailure: false,
  });
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(params)));
  const { refresh: refreshDetail } = detail;
  useFocusEffect(useCallback(() => refreshDetail(), [refreshDetail]));
  const permissions = usePullRequestPermissions(params, detail.data);
  const stale = detail.data && detail.data.headSha !== params.headSha;
  const pending = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (
      pending.current ||
      uploading ||
      store.busy ||
      !store.ready ||
      !body.trim() ||
      detail.isPending ||
      detail.error ||
      stale ||
      !permissions.canInlineComment
    )
      return;
    pending.current = true;
    setBusy(true);
    let locked = false;
    try {
      let hostedComment = saved?.hostedComment;
      if (hostedComment && saved) {
        const moved =
          saved.headSha !== params.headSha ||
          saved.path !== params.path ||
          JSON.stringify(saved.position) !== JSON.stringify(params.position);
        if (moved) {
          if (!(await pendingActions.discard(saved))) return;
          hostedComment = undefined;
        }
      }
      if (!setReviewDraftBusy(params, true)) return;
      locked = true;
      if (hostedComment && saved && body !== saved.body) {
        const target = pullRequestTarget(params);
        const result = await updateComment({
          ...target,
          input: {
            ...target.input,
            kind: "review-comment",
            commentId: hostedComment.commentId,
            body,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
      const comment = {
        id: commentId,
        path: params.path,
        ...(params.oldPath ? { oldPath: params.oldPath } : {}),
        position: params.position,
        headSha: params.headSha,
        code: params.code,
        body,
        ...(hostedComment ? { hostedComment } : {}),
      };
      store.update((draft) => ({
        ...draft,
        comments: [...draft.comments.filter((comment) => comment.id !== commentId), comment],
      }));
      await store.flush();
      if (!hostedComment && detail.data?.capabilities.review.draftComment === true) {
        const target = pullRequestTarget(params);
        const result = await saveDraftComment({
          ...target,
          input: { ...target.input, comment },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        store.update((draft) => ({
          ...draft,
          comments: draft.comments.map((entry) =>
            entry.id === comment.id ? { ...entry, hostedComment: result.value } : entry,
          ),
        }));
        await store.flush();
      }
      detail.refresh();
      navigation.goBack();
    } catch (cause) {
      Alert.alert(
        "Could not save the review comment",
        `${cause instanceof Error ? cause.message : "Saving failed."}\nYour draft is kept in T3. Try saving again.`,
      );
    } finally {
      if (locked) setReviewDraftBusy(params, false);
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <PullRequestSheetContent
      busy={busy || uploading}
      title={saved ? "Edit review comment" : "Review comment"}
      subtitle={`#${params.number} · ${reviewPositionLabel(params.position)}`}
      compact
    >
      <View className="gap-2 rounded-[20px] bg-grouped-card p-4">
        <Text className="font-mono text-xs text-foreground-muted">{params.path}</Text>
        <Text selectable className="font-mono text-xs">
          {params.code}
        </Text>
      </View>
      <PullRequestCommentComposer
        params={params}
        label="Inline review comment"
        placeholder="Write feedback on these lines…"
        editable={store.ready && !busy && !store.busy}
        autoFocus
        value={body}
        onChangeText={setBody}
        busy={busy}
        canSubmit={
          !uploading &&
          !store.busy &&
          store.ready &&
          Boolean(body.trim()) &&
          !detail.isPending &&
          detail.error === null &&
          !stale &&
          permissions.canInlineComment
        }
        submitLabel={busy ? "Saving…" : "Save draft"}
        showSubmitLabel
        onSubmit={() => void save()}
        onBusyChange={setUploading}
      />
      <Text className="text-xs text-foreground-muted">
        Saved comments are private until you submit your review.
      </Text>
      {stale ? (
        <Text className="text-sm text-danger-foreground">
          The branch changed. Return to the current diff and select the line again.
        </Text>
      ) : null}
      {store.error || detail.error ? (
        <Text className="text-sm text-danger-foreground">{store.error ?? detail.error}</Text>
      ) : null}
      {saved ? (
        <View className="flex-row items-center gap-2">
          <PullRequestPendingBadge />
          <View className="flex-1" />
          <PullRequestPendingCommentActions params={params} comment={saved} />
        </View>
      ) : null}
      {saved && (!saved.hostedComment || pendingActions.canDiscard) ? (
        <MaterialButton
          label="Delete draft"
          disabled={store.busy || busy || uploading}
          onPress={() =>
            Alert.alert("Delete this draft?", "Your other review comments will be kept.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: () =>
                  void pendingActions.discard(saved).then((discarded) => {
                    if (discarded) navigation.goBack();
                  }),
              },
            ])
          }
        />
      ) : null}
    </PullRequestSheetContent>
  );
}
