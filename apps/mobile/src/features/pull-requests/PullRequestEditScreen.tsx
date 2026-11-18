import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { PullRequestComment } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent } from "./PullRequestSheetContent";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { PullRequestCompletionSuggestions } from "./PullRequestCompletionSuggestions";
import { usePullRequestCompletions } from "./usePullRequestCompletions";
import { m } from "../../i18n/messages";

export type PullRequestEditParams = PullRequestParams &
  (
    | { readonly field: "title" | "body" }
    | {
        readonly field: "comment";
        /** Carried along because a reply loaded page by page is not in the cached activity. */
        readonly comment: Pick<PullRequestComment, "id" | "body" | "author" | "canEdit"> & {
          readonly kind: "issue-comment" | "review-comment";
        };
      }
  );

export function PullRequestEditScreen({ route }: StaticScreenProps<PullRequestEditParams>) {
  const params = route.params;
  const navigation = useNavigation();
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const pr = detail.data;
  const permissions = usePullRequestPermissions(params, pr);
  const gt = useGT();
  const update = useAtomCommand(composerPullRequests.update, { reportFailure: false });
  const updateComment = useAtomCommand(composerPullRequests.updateComment, {
    reportFailure: false,
  });
  const term = changeRequestTermKind(sourceControlClients.get(pr?.provider).changeRequest);
  const original =
    params.field === "comment"
      ? params.comment.body
      : params.field === "title"
        ? (pr?.title ?? null)
        : (pr?.body ?? null);
  const [edit, setEdit] = useState<{ body: string; original: string | null } | null>(null);
  const draft = edit?.body ?? null;
  const setDraft = (body: string) =>
    setEdit((current) => ({ body, original: current?.original ?? original }));
  const value = draft ?? original ?? "";
  const completions = usePullRequestCompletions({
    environmentId: params.environmentId,
    projectId: params.projectId,
    value: value,
    onChangeValue: setDraft,
    support: params.field === "title" ? null : (pr?.capabilities ?? null),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const allowed =
    params.field === "comment"
      ? permissions.canEditComment(params.comment)
      : permissions.canEditChangeRequest;
  const canWrite = useAtomValue(
    (params.field === "comment"
      ? composerPullRequests.updateComment
      : composerPullRequests.update
    ).permissionAtom(target.environmentId),
  );
  // Name the first thing in the way, so the notice says what would actually fix it.
  const readOnlyReason =
    !pr || allowed
      ? null
      : !permissions.connected
        ? gt("Reconnect to save changes.")
        : !canWrite
          ? gt("This device isn't allowed to change source control on this environment.")
          : params.field === "comment"
            ? gt("You can't edit this comment.")
            : gt(
                "You can't edit this {term, select, mr {merge request} cr {change request} other {pull request}}.",
                { term },
              );
  const unchanged = draft === null || draft === original;
  const invalid = params.field === "title" && value.trim().length === 0;
  const save = async () => {
    if (!allowed || unchanged || invalid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result =
      params.field === "comment"
        ? await updateComment({
            ...target,
            input: {
              ...target.input,
              commentId: params.comment.id,
              kind: params.comment.kind,
              body: value,
            },
          })
        : await update({
            ...target,
            input: {
              ...target.input,
              ...(params.field === "title"
                ? { title: value.trim() }
                : {
                    body: value,
                    ...(edit?.original === null || edit?.original === undefined
                      ? {}
                      : { expectedBody: edit.original }),
                  }),
            },
          });
    inFlight.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? (errorDisplayMessage(cause, m) ?? cause.message)
          : gt("The provider refused the change."),
      );
      return;
    }
    // updateComment refreshes the activity on its own; a title or body lives on the detail.
    if (params.field !== "comment") detail.refresh();
    navigation.goBack();
  };
  const title =
    params.field === "title"
      ? gt("Edit title")
      : params.field === "body"
        ? gt("Edit description")
        : gt("Edit comment");
  return (
    <PullRequestSheetContent
      busy={busy}
      title={title}
      subtitle={`#${params.number} · ${params.repository}`}
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={busy ? gt("Saving…") : gt("Save")}
          loading={busy}
          disabled={!allowed || unchanged || invalid || original === null}
          onPress={() => void save()}
        />
      }
    >
      <PullRequestCompletionSuggestions completions={completions} />
      <TextInput
        multiline={params.field !== "title"}
        selection={completions.selection}
        onSelectionChange={completions.onSelectionChange}
        onBlur={completions.onBlur}
        editable={!busy && original !== null}
        autoFocus
        accessibilityLabel={
          params.field === "title"
            ? gt(
                "{term, select, mr {Merge request} cr {Change request} other {Pull request}} title",
                { term },
              )
            : params.field === "body"
              ? gt(
                  "{term, select, mr {Merge request} cr {Change request} other {Pull request}} description",
                  { term },
                )
              : gt("Comment", { $context: "noun, field label" })
        }
        placeholder={
          params.field === "title"
            ? gt("Title", { $context: "field placeholder" })
            : gt("Write in Markdown…")
        }
        placeholderTextColorClassName="accent-foreground-muted"
        maxLength={params.field === "title" ? 1024 : 65536}
        value={value}
        onChangeText={setDraft}
        returnKeyType={params.field === "title" ? "done" : undefined}
        onSubmitEditing={params.field === "title" ? () => void save() : undefined}
        className={
          params.field === "title"
            ? "min-h-12 rounded-[20px] bg-grouped-card px-4 text-base text-foreground"
            : "min-h-48 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        }
        style={params.field === "title" ? undefined : { textAlignVertical: "top" }}
      />
      {readOnlyReason ? (
        <Text className="text-xs text-foreground-muted">{readOnlyReason}</Text>
      ) : null}
      {error || detail.error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error ?? detail.error}
        </Text>
      ) : null}
    </PullRequestSheetContent>
  );
}
