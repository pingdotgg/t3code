import { AsyncResult } from "effect/reactivity";
import { PullRequestCommentComposer } from "./PullRequestCommentComposer";
import { useAtomRefresh } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestReviewVerdict } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import { clearSubmittedReview } from "./pullRequestReviewDrafts";
import {
  PullRequestPendingBadge,
  PullRequestPendingCommentActions,
} from "./PullRequestPendingComment";
import {
  setReviewDraftBusy,
  retireReviewDraftComments,
  usePullRequestReviewDraft,
} from "./usePullRequestReviewDraft";
import { reviewPositionLabel } from "./pullRequestDiffComments";
import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent as SheetContent } from "./PullRequestSheetContent";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

function useActionSubmission(params: PullRequestParams) {
  const navigation = useNavigation();
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(pullRequestTarget(params)));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(pullRequestTarget(params)));
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const result = await settlePromise(async () => {
      await operation();
      refreshDetail();
      refreshActivity();
      navigation.goBack();
    });
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : "The provider could not complete this action. Try again.",
      );
    }
  };
  return { busy, error, submit };
}

const VERDICTS = [
  { value: "comment", title: "Comment" },
  { value: "approve", title: "Approve" },
  {
    value: "request-changes",
    title: "Request changes",
  },
] as const;

export function PullRequestReviewSheet({
  route,
}: StaticScreenProps<PullRequestParams & { readonly mode: "review" | "comment" }>) {
  const params = route.params;
  const target = pullRequestTarget(params);
  const result = useEnvironmentQuery(composerPullRequests.detail(target));
  const { refresh: refreshDetail } = result;
  useFocusEffect(() => refreshDetail());
  const permissions = usePullRequestPermissions(params, result.data);
  const submission = useActionSubmission(params);
  const [uploading, setUploading] = useState(false);
  const review = useAtomCommand(composerPullRequests.submitReview, { reportFailure: false });
  const comment = useAtomCommand(composerPullRequests.comment, { reportFailure: false });
  const navigation = useNavigation();
  const store = usePullRequestReviewDraft(params);
  const body = params.mode === "review" ? store.draft.summary : store.draft.comment;
  const setBody = (body: string) =>
    store.update((draft) => ({
      ...draft,
      ...(params.mode === "review" ? { summary: body } : { comment: body }),
    }));
  const stale = store.comments.some((comment) => comment.headSha !== result.data?.headSha);
  const [requestedVerdict, setRequestedVerdict] = useState<PullRequestReviewVerdict>("comment");
  const offered = VERDICTS.filter((option) => permissions.verdicts.includes(option.value));
  const verdict = offered.find((option) => option.value === requestedVerdict) ?? offered[0];
  const reviewing = params.mode === "review";
  const canSubmitComments = !store.comments.length || permissions.canInlineComment;
  // Forgejo requires a summary when requesting changes, even with inline comments.
  const summaryRequired =
    verdict !== undefined && result.data
      ? sourceControlClients.get(result.data.provider).reviewSummaryRequired(verdict.value)
      : false;
  const canSubmit =
    store.ready &&
    !uploading &&
    !store.busy &&
    (!reviewing || (!stale && canSubmitComments)) &&
    (reviewing
      ? verdict !== undefined &&
        (summaryRequired
          ? body.trim().length > 0
          : verdict.value === "approve" ||
            body.trim().length > 0 ||
            store.comments.length > 0 ||
            Boolean(store.pendingReviewId))
      : permissions.canComment && body.trim().length > 0);
  const perform = () =>
    submission.submit(async () => {
      if (!canSubmit)
        throw new Error("Add your feedback and check your permissions before submitting.");
      if (!setReviewDraftBusy(params, true))
        throw new Error("Wait for the pending comment to finish saving.");
      return await (async () => {
        const submitted = { ...store.draft, comments: store.comments };
        const response =
          reviewing && verdict
            ? await review({
                ...target,
                input: {
                  ...target.input,
                  verdict: verdict.value,
                  body,
                  ...(store.pendingReviewId ? { pendingReviewId: store.pendingReviewId } : {}),
                  comments: submitted.comments.map(
                    ({ id: _id, headSha: _sha, code: _code, ...comment }) => comment,
                  ),
                },
              })
            : await comment({ ...target, input: { ...target.input, body } });
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        if (reviewing) retireReviewDraftComments(params, submitted.comments);
        store.update((current) =>
          reviewing
            ? clearSubmittedReview(current, submitted)
            : { ...current, comment: current.comment === submitted.comment ? "" : current.comment },
        );
        await store.flush();
      })().finally(async () => {
        setReviewDraftBusy(params, false);
      });
    });
  return (
    <SheetContent
      title={reviewing ? "Submit review" : "Add comment"}
      subtitle={`#${params.number}${reviewing && result.data?.headSha ? ` · reviewing ${result.data.headSha.slice(0, 7)}` : ` · ${params.repository}`}`}
      busy={submission.busy || uploading}
      compact
    >
      {reviewing && offered.length > 1 ? (
        <SegmentedControl
          options={offered.map((option) => ({ value: option.value, label: option.title }))}
          selected={verdict?.value ?? "comment"}
          onSelect={(value) => {
            if (!submission.busy) setRequestedVerdict(value);
          }}
          size="compact"
        />
      ) : null}
      <PullRequestCommentComposer
        params={params}
        label={reviewing ? "Review summary" : "Comment"}
        placeholder={
          reviewing
            ? summaryRequired
              ? "Summary required to request changes…"
              : "Summarize your review…"
            : "Write a comment…"
        }
        editable={store.ready && !submission.busy && !store.busy}
        value={body}
        onChangeText={setBody}
        busy={submission.busy}
        canSubmit={canSubmit && !result.isPending && result.error === null}
        submitLabel={
          submission.busy
            ? "Submitting…"
            : reviewing
              ? verdict?.value === "approve"
                ? "Approve"
                : verdict?.value === "request-changes"
                  ? "Request changes"
                  : "Submit review"
              : "Post comment"
        }
        showSubmitLabel={reviewing}
        onSubmit={() => void perform()}
        onBusyChange={setUploading}
        autoFocus={!reviewing}
      />
      {reviewing && store.comments.length ? (
        <View className="gap-2">
          <Text className="text-sm font-t3-medium">
            {store.comments.length} pending line{" "}
            {store.comments.length === 1 ? "comment" : "comments"}
          </Text>
          {store.comments.map((draft) => (
            <View key={draft.id} className="gap-1 rounded-[20px] bg-grouped-card p-4">
              <View className="flex-row items-center gap-2">
                <PullRequestPendingBadge />
                <View className="flex-1" />
                <PullRequestPendingCommentActions params={params} comment={draft} />
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={submission.busy}
                onPress={() => {
                  const outdated = draft.headSha !== result.data?.headSha;
                  if (outdated)
                    navigation.dispatch(
                      StackActions.replace("PullRequestFile", {
                        ...params,
                        path: draft.path,
                        replacingDraftId: draft.id,
                      }),
                    );
                  else
                    navigation.dispatch(
                      StackActions.replace("PullRequestInlineComment", {
                        ...params,
                        ...draft,
                        draftId: draft.id,
                      }),
                    );
                }}
                className="gap-1"
              >
                <Text className="font-mono text-xs text-foreground-muted">
                  {draft.path} · {reviewPositionLabel(draft.position)}
                </Text>
                <Text numberOfLines={3} className="text-sm">
                  {draft.body}
                </Text>
                <Text className="text-2xs text-foreground-muted">
                  {draft.headSha !== result.data?.headSha
                    ? "Branch changed · Tap to choose a new line"
                    : "Tap to edit"}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {reviewing && stale ? (
        <Text className="text-sm text-danger-foreground">
          The branch changed since you wrote a comment. Choose its current line before submitting.
        </Text>
      ) : null}
      {reviewing && !canSubmitComments ? (
        <Text className="text-sm text-danger-foreground">
          You can no longer submit line comments on this pull request. Your drafts are kept here.
        </Text>
      ) : null}
      {submission.error || result.error || store.error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {submission.error ?? result.error ?? store.error}
        </Text>
      ) : null}
    </SheetContent>
  );
}
