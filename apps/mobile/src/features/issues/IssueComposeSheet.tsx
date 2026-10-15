import { RegistryContext } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { use, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent as SheetContent } from "../pull-requests/PullRequestSheetContent";
import type { IssueParams } from "./issueSelection";
import { issueTarget, markIssueTargetWritten, useIssueAccess } from "./useIssueAccess";

export function IssueComposeSheet({
  route,
}: StaticScreenProps<IssueParams & { readonly mode: "comment" | "edit" }>) {
  const params = route.params;
  const editing = params.mode === "edit";
  const navigation = useNavigation();
  const registry = use(RegistryContext);
  const target = issueTarget(params);
  const result = useEnvironmentQuery(issueEnvironment.detail(target));
  const issue = result.data;
  const access = useIssueAccess(params, issue);
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const [draft, setDraft] = useState<{ title?: string; body?: string }>({});
  const title = draft.title ?? (editing ? (issue?.title ?? "") : "");
  const body = draft.body ?? (editing ? (issue?.body ?? "") : "");
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = editing ? access.edit : access.comment;
  const bodyLocked = editing && !access.editBody;
  const changed = editing
    ? title.trim() !== issue?.title || (!bodyLocked && body !== issue?.body)
    : true;
  const canSubmit =
    allowed && changed && (editing ? title.trim().length > 0 : body.trim().length > 0);
  const submit = async () => {
    if (pending.current || !canSubmit) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = editing
        ? await update({
            ...target,
            input: {
              ...target.input,
              ...(title.trim() !== issue?.title ? { title: title.trim() } : {}),
              ...(!bodyLocked && body !== issue?.body ? { body } : {}),
            },
          })
        : await comment({ ...target, input: { ...target.input, body } });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      markIssueTargetWritten(registry, params);
      navigation.goBack();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The tracker could not save this. Try again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <SheetContent
      title={editing ? "Edit issue" : "Add comment"}
      subtitle={`${issue?.displayKey ?? params.displayKey ?? params.key} · ${params.scope}`}
      busy={busy}
      footer={
        <MaterialButton
          label={busy ? "Saving…" : editing ? "Save" : "Post comment"}
          fullWidth
          tone={Platform.OS === "android" ? "primary" : "contrast"}
          loading={busy}
          disabled={!canSubmit || !issue}
          onPress={() => void submit()}
        />
      }
    >
      {editing ? (
        <TextInput
          accessibilityLabel="Title"
          placeholder="Title"
          placeholderTextColorClassName="accent-foreground-muted"
          editable={!busy && Boolean(issue)}
          value={title}
          maxLength={1024}
          onChangeText={(next) => setDraft((held) => ({ ...held, title: next }))}
          className="min-h-12 rounded-[20px] bg-grouped-card px-4 text-base text-foreground"
        />
      ) : null}
      <TextInput
        multiline
        accessibilityLabel={editing ? "Description" : "Comment"}
        placeholder={editing ? "Description" : "Write a comment…"}
        placeholderTextColorClassName="accent-foreground-muted"
        editable={!busy && Boolean(issue) && !bodyLocked}
        value={body}
        maxLength={65536}
        onChangeText={(next) => setDraft((held) => ({ ...held, body: next }))}
        className="min-h-36 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      {issue && allowed && bodyLocked ? (
        <>
          <Text className="text-xs text-foreground-muted">
            This description has formatting that can't be edited here.
          </Text>
          <MaterialButton
            label="Edit description in browser"
            onPress={() => void Linking.openURL(issue.url)}
          />
        </>
      ) : null}
      {issue && !allowed ? (
        <Text className="text-xs text-foreground-muted">
          {access.connected
            ? `${editing ? "Editing" : "Commenting"} isn't available for this issue with your access.`
            : `This environment is offline. Reconnect to ${editing ? "edit this issue" : "comment"}.`}
        </Text>
      ) : null}
      {error || result.error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error ?? result.error}
        </Text>
      ) : null}
    </SheetContent>
  );
}
