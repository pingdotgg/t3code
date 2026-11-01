import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { PullRequestComment } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent } from "./PullRequestSheetContent";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

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
  const update = useAtomCommand(composerPullRequests.update, { reportFailure: false });
  const updateComment = useAtomCommand(composerPullRequests.updateComment, {
    reportFailure: false,
  });
  const singular = sourceControlClients.get(pr?.provider).changeRequest.singular;
  const original =
    params.field === "comment"
      ? params.comment.body
      : params.field === "title"
        ? (pr?.title ?? null)
        : (pr?.body ?? null);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? original ?? "";
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
        ? "Reconnect to save changes."
        : !canWrite
          ? "This device isn't allowed to change source control on this environment."
          : params.field === "comment"
            ? "You can't edit this comment."
            : `You can't edit this ${singular}.`;
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
              ...(params.field === "title" ? { title: value.trim() } : { body: value }),
            },
          });
    inFlight.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The provider refused the change.");
      return;
    }
    // updateComment refreshes the activity on its own; a title or body lives on the detail.
    if (params.field !== "comment") detail.refresh();
    navigation.goBack();
  };
  const title =
    params.field === "title"
      ? "Edit title"
      : params.field === "body"
        ? "Edit description"
        : "Edit comment";
  return (
    <PullRequestSheetContent
      busy={busy}
      title={title}
      subtitle={`#${params.number} · ${params.repository}`}
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={busy ? "Saving…" : "Save"}
          loading={busy}
          disabled={!allowed || unchanged || invalid || original === null}
          onPress={() => void save()}
        />
      }
    >
      <TextInput
        multiline={params.field !== "title"}
        editable={!busy && original !== null}
        autoFocus
        accessibilityLabel={
          params.field === "title"
            ? `${capitalizeTerm(singular)} title`
            : params.field === "body"
              ? `${capitalizeTerm(singular)} description`
              : "Comment"
        }
        placeholder={params.field === "title" ? "Title" : "Write in Markdown…"}
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
