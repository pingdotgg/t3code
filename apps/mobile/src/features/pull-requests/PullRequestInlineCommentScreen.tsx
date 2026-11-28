import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Dialog from "../../components/ui/Dialog";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";
import type { PullRequestReviewPosition } from "@t3tools/contracts";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { uuidv4 } from "../../lib/uuid";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { PullRequestSheetContent } from "./PullRequestSheetContent";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { reviewPositionLabel } from "./pullRequestDiffComments";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { PullRequestCompletionSuggestions } from "./PullRequestCompletionSuggestions";
import { usePullRequestCompletions } from "./usePullRequestCompletions";

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
  const gt = useGT();
  const m = useMessages();
  const store = usePullRequestReviewDraft(params);
  const saved = store.draft.comments.find((draft) => draft.id === params.draftId);
  // A retry after a failed write must replace the comment the first try added.
  const [commentId] = useState(() => params.draftId ?? uuidv4());
  const [editedBody, setBody] = useState<string | null>(null);
  const body = editedBody ?? saved?.body ?? "";
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(params)));
  const { refresh: refreshDetail } = detail;
  const completions = usePullRequestCompletions({
    environmentId: params.environmentId,
    projectId: params.projectId,
    value: body,
    onChangeValue: setBody,
    support: detail.data?.capabilities ?? null,
  });
  useFocusEffect(refreshDetail);
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
        ...draft.comments.filter((comment) => comment.id !== commentId),
        {
          id: commentId,
          path: params.path,
          ...(params.oldPath ? { oldPath: params.oldPath } : {}),
          position: params.position,
          headSha: params.headSha,
          code: params.code,
          body,
        },
      ],
    }));
    // flush resolves false when the write fails; the draft store's error field says why.
    const result = await settlePromise(() => store.flush());
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isSuccess(result) && result.value) navigation.goBack();
  };
  return (
    <PullRequestSheetContent
      busy={busy}
      title={saved ? gt("Edit review comment") : gt("Review comment")}
      subtitle={`#${params.number} · ${reviewPositionLabel(params.position, m)}`}
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={busy ? gt("Saving…") : gt("Save draft")}
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
      <PullRequestCompletionSuggestions completions={completions} />
      <TextInput
        multiline
        selection={completions.selection}
        onSelectionChange={completions.onSelectionChange}
        onBlur={completions.onBlur}
        editable={store.ready && !busy}
        autoFocus
        accessibilityLabel={gt("Inline review comment")}
        placeholder={gt("Write feedback on this line…")}
        placeholderTextColorClassName="accent-foreground-muted"
        maxLength={65536}
        value={body}
        onChangeText={setBody}
        className="min-h-32 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      <Text className="text-xs text-foreground-muted">
        <T>Saved comments are private until you submit your review.</T>
      </Text>
      {stale ? (
        <Text className="text-sm text-danger-foreground">
          <T>The branch changed. Return to the current diff and select the line again.</T>
        </Text>
      ) : null}
      {store.error || detail.error ? (
        <Text className="text-sm text-danger-foreground">{store.error ?? detail.error}</Text>
      ) : null}
      {saved ? (
        <Button
          label={gt("Delete draft")}
          onPress={() =>
            Dialog.alert(gt("Delete this draft?"), gt("Your other review comments will be kept."), [
              { text: gt("Cancel"), style: "cancel" },
              {
                text: gt("Delete"),
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
