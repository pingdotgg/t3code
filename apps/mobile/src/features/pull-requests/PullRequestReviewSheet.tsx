import { m as resolveMessage } from "../../i18n/messages";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { AsyncResult } from "effect/reactivity";
import { PullRequestCommentForm } from "./PullRequestCommentForm";
import { useAtomRefresh } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestReviewVerdict } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Alert, Pressable, View } from "react-native";
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
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent as SheetContent } from "./PullRequestSheetContent";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

function useActionSubmission(params: PullRequestParams) {
  const gt = useGT();
  const navigation = useNavigation();
  const target = pullRequestTarget(params);
  const refreshDetail = useAtomRefresh(
    composerPullRequests.detail({ ...target, input: { ...target.input, allowStale: false } }),
  );
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
  const result = useEnvironmentQuery(
    composerPullRequests.detail({ ...target, input: { ...target.input, allowStale: false } }),
  );
  const { refresh: refreshDetail } = result;
  useFocusEffect(refreshDetail);
  const permissions = usePullRequestPermissions(params, result.data);
  const submission = useActionSubmission(params);
  const [uploading, setUploading] = useState(false);
  const [pendingLocalSave, setPendingLocalSave] = useState(false);
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
    (!reviewing ||
      (store.activityLoaded && store.activityError === null && !stale && canSubmitComments)) &&
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
      if (pendingLocalSave) {
        if (!store.isReady() || !(await store.flush()))
          throw new Error(
            gt(
              "The review was submitted, but this device could not save the cleared draft. Retry saving without submitting again.",
            ),
          );
        setPendingLocalSave(false);
        return;
      }
      if (!canSubmit || !store.isReady())
        throw new Error(gt("Add your feedback and check your permissions before submitting."));
      if (!setReviewDraftBusy(store.scope, true))
        throw new Error(gt("Wait for the pending comment to finish saving."));
      return await (async () => {
        const submitted = store.draft;
        const submittedComments = store.comments;
        const response =
          reviewing && verdict
            ? await review({
                ...target,
                input: {
                  ...target.input,
                  verdict: verdict.value,
                  body,
                  ...(store.pendingReviewId ? { pendingReviewId: store.pendingReviewId } : {}),
                  ...(store.outdatedComments.length
                    ? { outdatedComments: store.outdatedComments }
                    : {}),
                  comments: submittedComments.map(
                    ({ id: _id, headSha: _sha, code: _code, ...comment }) => comment,
                  ),
                },
              })
            : await comment({ ...target, input: { ...target.input, body } });
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        store.refreshActivity();
        if (reviewing)
          retireReviewDraftComments(
            store.scope,
            submittedComments,
            store.outdatedComments.map((comment) => comment.id),
          );
        store.complete((current) =>
          reviewing
            ? clearSubmittedReview(current, submitted)
            : { ...current, comment: current.comment === submitted.comment ? "" : current.comment },
        );
        if (!(await store.flush())) {
          setPendingLocalSave(true);
          throw new Error(
            gt(
              "The review was submitted, but this device could not save the cleared draft. Retry saving without submitting again.",
            ),
          );
        }
      })().finally(async () => {
        setReviewDraftBusy(store.scope, false);
      });
    });
  const verdictMenu =
    reviewing && offered.length > 1 ? (
      <Menu
        title={gt("Review verdict")}
        actions={offered.map((option) => ({
          id: option.value,
          title: m(option.title),
          state: option.value === verdict?.value ? ("on" as const) : ("off" as const),
        }))}
        onPressAction={({ nativeEvent }) => {
          const next = offered.find((option) => option.value === nativeEvent.event);
          if (next && !submission.busy) setRequestedVerdict(next.value);
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Review verdict: {verdict}", {
            verdict: verdict ? m(verdict.title) : gt("Comment", { $context: "review verdict" }),
          })}
          disabled={submission.busy}
          className="h-11 flex-row items-center gap-1.5 rounded-full border border-border-subtle px-3.5 active:opacity-70"
        >
          <Text className="text-xs font-t3-bold">
            {verdict ? m(verdict.title) : gt("Comment", { $context: "review verdict" })}
          </Text>
          <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </Menu>
    ) : null;
  return (
    <SheetContent
      title={reviewing ? gt("Submit review") : gt("Add comment")}
      subtitle={`#${params.number} · ${
        reviewing && result.data?.headSha
          ? gt("reviewing {sha}", { sha: result.data.headSha.slice(0, 7) })
          : params.repository
      }`}
      busy={submission.busy || uploading}
      compact
      footer={
        <View className="flex-row items-center gap-2">
          {verdictMenu}
          <View className="flex-1" />
          <Button
            tone="text"
            label={gt("Cancel")}
            disabled={submission.busy}
            onPress={() => navigation.goBack()}
          />
          <Button
            tone={reviewing ? "primary" : "secondary"}
            label={
              pendingLocalSave
                ? gt("Retry saving")
                : submission.busy
                  ? reviewing
                    ? gt("Submitting…")
                    : gt("Posting…")
                  : reviewing
                    ? gt("Submit review")
                    : gt("Comment")
            }
            loading={submission.busy}
            disabled={
              (!pendingLocalSave && !canSubmit) ||
              result.isPending ||
              result.error !== null ||
              submission.busy
            }
            onPress={() => void perform()}
          />
        </View>
      }
    >
      {store.legacyDraftAvailable ? (
        <View className="gap-2 rounded-2xl bg-grouped-card p-4">
          <Text className="text-sm text-foreground-muted">
            {gt(
              "Earlier drafts on this device have no account information. Restore them only if you wrote them for {viewer}.",
              { viewer: store.scope.viewer ?? "" },
            )}
          </Text>
          <Button
            tone="text"
            label={gt("Restore my earlier drafts")}
            disabled={submission.busy || store.busy}
            onPress={() =>
              Alert.alert(
                gt("Restore drafts for {viewer}?", { viewer: store.scope.viewer ?? "" }),
                gt(
                  "Only continue if you wrote these earlier drafts for this account. They will become available to this account on this device.",
                ),
                [
                  { text: gt("Cancel"), style: "cancel" },
                  {
                    text: gt("I wrote these drafts"),
                    onPress: () => {
                      void store.recoverLegacyDraft().then((saved) => {
                        if (!saved)
                          Alert.alert(
                            gt("Could not restore the drafts"),
                            gt("The earlier drafts are kept on this device. Try again."),
                          );
                      });
                    },
                  },
                ],
              )
            }
          />
        </View>
      ) : null}
      {reviewing && store.activityError ? (
        <View className="gap-2">
          <Text className="text-sm text-danger-foreground">{store.activityError}</Text>
          <Button
            label={gt("Retry loading pending review")}
            tone="text"
            onPress={store.refreshActivity}
          />
        </View>
      ) : null}
      <Text className="px-4 text-xs text-foreground-muted">
        {reviewing ? gt("Summary") : gt("Comment", { $context: "noun, field label" })}
      </Text>
      <PullRequestCommentForm
        params={params}
        label={reviewing ? gt("Review summary") : gt("Comment", { $context: "noun, field label" })}
        placeholder={
          reviewing
            ? summaryRequired
              ? gt("Summary required to request changes…")
              : gt("Summarize your review…")
            : gt("Leave a comment")
        }
        editable={store.ready && !submission.busy && !store.busy}
        value={body}
        onChangeText={setBody}
        busy={submission.busy}
        onBusyChange={setUploading}
        autoFocus={!reviewing}
      />
      {reviewing && store.comments.length ? (
        <View className="gap-2">
          <Text className="text-xs text-foreground-muted">
            {gt(
              "{count, plural, one {{count} pending line comment will post with this review} other {{count} pending line comments will post with this review}}",
              { count: store.comments.length },
            )}
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
                  {draft.path} · {reviewPositionLabel(draft.position, draft.startPosition, m)}
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
            </View>
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
