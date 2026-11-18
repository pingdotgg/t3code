import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { AsyncResult } from "effect/reactivity";
import { useAtomRefresh } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestReviewVerdict } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import { clearSubmittedReview } from "./pullRequestReviewDrafts";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { reviewPositionLabel } from "./pullRequestDiffComments";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent as SheetContent } from "./PullRequestSheetContent";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { PullRequestCompletionSuggestions } from "./PullRequestCompletionSuggestions";
import { usePullRequestCompletions } from "./usePullRequestCompletions";
import { m as resolveMessage } from "../../i18n/messages";

function useActionSubmission(params: PullRequestParams) {
  const navigation = useNavigation();
  const gt = useGT();
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
          ? (errorDisplayMessage(cause, resolveMessage) ?? cause.message)
          : gt("The provider could not complete this action. Try again."),
      );
    }
  };
  return { busy, error, submit };
}

const VERDICTS = [
  { value: "comment", title: msg("Comment", { $context: "review verdict" }) },
  { value: "approve", title: msg("Approve", { $context: "review verdict" }) },
  {
    value: "request-changes",
    title: msg("Request changes"),
  },
] as const;

export function PullRequestReviewSheet({
  route,
}: StaticScreenProps<PullRequestParams & { readonly mode: "review" | "comment" }>) {
  const params = route.params;
  const gt = useGT();
  const m = useMessages();
  const target = pullRequestTarget(params);
  const result = useEnvironmentQuery(composerPullRequests.detail(target));
  const { refresh: refreshDetail } = result;
  useFocusEffect(refreshDetail);
  const permissions = usePullRequestPermissions(params, result.data);
  const submission = useActionSubmission(params);
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
  const completions = usePullRequestCompletions({
    environmentId: params.environmentId,
    projectId: params.projectId,
    value: body,
    onChangeValue: setBody,
    support: result.data?.capabilities ?? null,
  });
  const stale = store.draft.comments.some((comment) => comment.headSha !== result.data?.headSha);
  const [requestedVerdict, setRequestedVerdict] = useState<PullRequestReviewVerdict>("comment");
  const offered = VERDICTS.filter((option) => permissions.verdicts.includes(option.value));
  const verdict = offered.find((option) => option.value === requestedVerdict) ?? offered[0];
  const reviewing = params.mode === "review";
  const canSubmitComments = !store.draft.comments.length || permissions.canInlineComment;
  // Forgejo requires a summary when requesting changes, even with inline comments.
  const summaryRequired =
    verdict !== undefined && result.data
      ? sourceControlClients.get(result.data.provider).reviewSummaryRequired(verdict.value)
      : false;
  const canSubmit =
    store.ready &&
    (!reviewing || (!stale && canSubmitComments)) &&
    (reviewing
      ? verdict !== undefined &&
        (summaryRequired
          ? body.trim().length > 0
          : verdict.value === "approve" ||
            body.trim().length > 0 ||
            store.draft.comments.length > 0)
      : permissions.canComment && body.trim().length > 0);
  const perform = () =>
    submission.submit(async () => {
      if (!canSubmit)
        throw new Error(gt("Add your feedback and check your permissions before submitting."));
      const submitted = store.draft;
      const response =
        reviewing && verdict
          ? await review({
              ...target,
              input: {
                ...target.input,
                verdict: verdict.value,
                body,
                comments: submitted.comments.map(
                  ({ id: _id, headSha: _sha, code: _code, ...comment }) => comment,
                ),
              },
            })
          : await comment({ ...target, input: { ...target.input, body } });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      store.update((current) =>
        reviewing
          ? clearSubmittedReview(current, submitted)
          : { ...current, comment: current.comment === submitted.comment ? "" : current.comment },
      );
      await store.flush();
    });
  return (
    <SheetContent
      title={reviewing ? gt("Submit review") : gt("Add comment")}
      subtitle={`#${params.number} · ${
        reviewing && result.data?.headSha
          ? gt("reviewing {sha}", { sha: result.data.headSha.slice(0, 7) })
          : params.repository
      }`}
      busy={submission.busy}
      footer={
        <Button
          label={
            submission.busy
              ? gt("Submitting…")
              : reviewing
                ? verdict?.value === "approve"
                  ? gt("Approve", { $context: "review verdict" })
                  : verdict?.value === "request-changes"
                    ? gt("Request changes")
                    : gt("Submit review")
                : gt("Post comment")
          }
          fullWidth
          tone="contrast"
          loading={submission.busy}
          disabled={!canSubmit || result.isPending || result.error !== null}
          onPress={() => void perform()}
        />
      }
    >
      {reviewing && offered.length > 1 ? (
        <SegmentedControl
          options={offered.map((option) => ({ value: option.value, label: m(option.title) }))}
          selected={verdict?.value ?? "comment"}
          onSelect={(value) => {
            if (!submission.busy) setRequestedVerdict(value);
          }}
          size="compact"
        />
      ) : null}
      <Text className="px-4 text-xs text-foreground-muted">
        {reviewing ? gt("Summary") : gt("Comment", { $context: "noun, field label" })}
      </Text>
      <PullRequestCompletionSuggestions completions={completions} />
      <TextInput
        multiline
        selection={completions.selection}
        onSelectionChange={completions.onSelectionChange}
        onBlur={completions.onBlur}
        accessibilityLabel={
          reviewing ? gt("Review summary") : gt("Comment", { $context: "noun, field label" })
        }
        placeholder={
          reviewing
            ? summaryRequired
              ? gt("Summary required to request changes…")
              : gt("Summarize your review…")
            : gt("Write a comment…")
        }
        placeholderTextColorClassName="accent-foreground-muted"
        editable={store.ready && !submission.busy}
        value={body}
        maxLength={65536}
        onChangeText={setBody}
        className="min-h-36 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      {reviewing && store.draft.comments.length ? (
        <View className="gap-2">
          <Text className="text-sm font-t3-medium">
            {gt(
              "{count, plural, one {{count} pending line comment} other {{count} pending line comments}}",
              { count: store.draft.comments.length },
            )}
          </Text>
          {store.draft.comments.map((draft) => (
            <Pressable
              key={draft.id}
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
              className="gap-1 rounded-[20px] bg-grouped-card p-4"
            >
              <Text className="font-mono text-xs text-foreground-muted">
                {draft.path} · {reviewPositionLabel(draft.position, m)}
              </Text>
              <Text numberOfLines={3} className="text-sm">
                {draft.body}
              </Text>
              <Text className="text-2xs text-foreground-muted">
                {draft.headSha !== result.data?.headSha
                  ? gt("Branch changed · Tap to choose a new line")
                  : gt("Tap to edit")}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {reviewing && stale ? (
        <Text className="text-sm text-danger-foreground">
          <T>
            The branch changed since you wrote a comment. Choose its current line before submitting.
          </T>
        </Text>
      ) : null}
      {reviewing && !canSubmitComments ? (
        <Text className="text-sm text-danger-foreground">
          {gt(
            "You can no longer submit line comments on this {term, select, mr {merge request} cr {change request} other {pull request}}. Your drafts are kept here.",
            {
              term: changeRequestTermKind(
                sourceControlClients.get(result.data?.provider).changeRequest,
              ),
            },
          )}
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
