import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useRef, useState } from "react";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { issueEnvironment, refreshIssueLists } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent } from "../pull-requests/PullRequestSheetContent";
import { issueTarget, type IssueParams } from "./issueParams";
import { issueCommandError, useIssueAccess } from "./issuePresentation";

type IssueEditParams = IssueParams & { readonly field: "title" | "body" };

export function IssueEditScreen({ route }: StaticScreenProps<IssueEditParams>) {
  const params = route.params;
  const navigation = useNavigation();
  const target = issueTarget(params);
  const detailQuery = useEnvironmentQuery(issueEnvironment.detail(target));
  const detail = detailQuery.data;
  const access = useIssueAccess(params, detail);
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const isTitle = params.field === "title";
  const original = detail ? (isTitle ? detail.title : detail.body) : null;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? original ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const allowed = access?.edit === true;
  const unchanged = draft === null || draft === original;
  const invalid = isTitle && value.trim().length === 0;
  const save = async () => {
    if (!allowed || unchanged || invalid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const failure = issueCommandError(
      await update({
        ...target,
        input: { ...target.input, ...(isTitle ? { title: value.trim() } : { body: value }) },
      }),
    );
    inFlight.current = false;
    setBusy(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    refreshIssueLists(target.environmentId);
    navigation.goBack();
  };
  return (
    <PullRequestSheetContent
      busy={busy}
      title={isTitle ? "Edit title" : "Edit description"}
      subtitle={`${detail?.displayKey ?? params.issueKey} · ${params.scope}`}
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
        multiline={!isTitle}
        editable={!busy && original !== null}
        autoFocus
        accessibilityLabel={isTitle ? "Issue title" : "Issue description"}
        placeholder={isTitle ? "Title" : "Write in Markdown…"}
        placeholderTextColorClassName="accent-foreground-muted"
        maxLength={isTitle ? 1024 : 65536}
        value={value}
        onChangeText={setDraft}
        returnKeyType={isTitle ? "done" : undefined}
        onSubmitEditing={isTitle ? () => void save() : undefined}
        className={
          isTitle
            ? "min-h-12 rounded-[20px] bg-grouped-card px-4 text-base text-foreground"
            : "min-h-48 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        }
        style={isTitle ? undefined : { textAlignVertical: "top" }}
      />
      {detail && !allowed ? (
        <Text className="text-xs text-foreground-muted">
          {access?.blocked ?? "You can't edit this issue."}
        </Text>
      ) : null}
      {error || detailQuery.error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error ?? detailQuery.error}
        </Text>
      ) : null}
    </PullRequestSheetContent>
  );
}
