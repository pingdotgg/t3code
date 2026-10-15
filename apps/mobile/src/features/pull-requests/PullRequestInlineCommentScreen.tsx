import * as Dialog from "../../components/Dialog";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import type { PullRequestReviewPosition } from "@t3tools/contracts";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { Button } from "../../components/Button";
import { uuidv4 } from "../../lib/uuid";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { PullRequestSheetContent } from "./PullRequestSheetContent";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { reviewPositionLabel } from "./pullRequestDiffComments";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

export type InlineCommentParams = PullRequestParams & {
  readonly draftId?: string;
  readonly path: string;
  readonly oldPath?: string;
  readonly position: PullRequestReviewPosition;
  readonly headSha: string;
  readonly code: string;
};
export function PullRequestInlineCommentScreen({ route }: StaticScreenProps<InlineCommentParams>) {
  const params = route.params;
  const navigation = useNavigation();
  const store = usePullRequestReviewDraft(params);
  const saved = store.draft.comments.find((draft) => draft.id === params.draftId);
  const [editedBody, setBody] = useState<string | null>(null);
  const body = editedBody ?? saved?.body ?? "";
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(params)));
  const { refresh: refreshDetail } = detail;
  useFocusEffect(useCallback(() => refreshDetail(), [refreshDetail]));
  const permissions = usePullRequestPermissions(params, detail.data);
  const stale = detail.data && detail.data.headSha !== params.headSha;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (
      pending.current ||
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
    store.update((draft) => ({
      ...draft,
      comments: [
        ...draft.comments.filter((comment) => comment.id !== params.draftId),
        {
          id: params.draftId ?? uuidv4(),
          path: params.path,
          ...(params.oldPath ? { oldPath: params.oldPath } : {}),
          position: params.position,
          headSha: params.headSha,
          code: params.code,
          body,
        },
      ],
    }));
    try {
      await store.flush();
      navigation.goBack();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <PullRequestSheetContent
      busy={busy}
      title={saved ? "Edit review comment" : "Review comment"}
      subtitle={`#${params.number} · ${reviewPositionLabel(params.position)}`}
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={busy ? "Saving…" : "Save draft"}
          loading={busy}
          disabled={
            !store.ready ||
            !body.trim() ||
            detail.isPending ||
            detail.error !== null ||
            Boolean(stale) ||
            !permissions.canInlineComment
          }
          onPress={() => void save()}
        />
      }
    >
      <View className="gap-2 rounded-[20px] bg-grouped-card p-4">
        <Text className="font-mono text-xs text-foreground-muted">{params.path}</Text>
        <Text selectable className="font-mono text-xs">
          {params.code}
        </Text>
      </View>
      <TextInput
        multiline
        editable={store.ready && !busy}
        autoFocus
        accessibilityLabel="Inline review comment"
        placeholder="Write feedback on this line…"
        placeholderTextColorClassName="accent-foreground-muted"
        maxLength={65536}
        value={body}
        onChangeText={setBody}
        className="min-h-32 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
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
        <Button
          label="Delete draft"
          onPress={() =>
            Dialog.alert("Delete this draft?", "Your other review comments will be kept.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: () => {
                  store.update((draft) => ({
                    ...draft,
                    comments: draft.comments.filter((comment) => comment.id !== saved.id),
                  }));
                  navigation.goBack();
                },
              },
            ])
          }
        />
      ) : null}
    </PullRequestSheetContent>
  );
}
