import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { useIssueCreateScopes } from "./useIssueCreateScopes";
import { issueEnvironment, refreshIssueLists } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSheetContent } from "../pull-requests/PullRequestSheetContent";
import { usePullRequestConnected } from "../pull-requests/usePullRequestConnected";
import type { IssueParams } from "./issueParams";
import { issueCommandError } from "./issuePresentation";

const BLANK = "__blank__";

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly selected: string;
  readonly disabled?: boolean;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <Menu
      title={props.label}
      actions={props.options.map((option) => ({
        id: option.id,
        title: option.title,
        state: option.id === props.selected ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        disabled={props.disabled}
        className="min-h-12 flex-row items-center gap-3 rounded-[20px] bg-grouped-card px-4 active:opacity-70"
      >
        <Text className="text-sm text-foreground-muted">{props.label}</Text>
        <Text className="min-w-0 flex-1 text-right text-sm" numberOfLines={1}>
          {props.value}
        </Text>
        <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </Menu>
  );
}

/**
 * One draft on any tracker: a chosen template fills the title, body, labels and assignees, and
 * the writer takes it from there.
 */
export function IssueCreateScreen() {
  const { scopes, isPending: scopesPending } = useIssueCreateScopes();
  const navigation = useNavigation();
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)] ?? null;
  const [templateKey, setTemplateKey] = useState(BLANK);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [extras, setExtras] = useState<{
    readonly labels: ReadonlyArray<string>;
    readonly assignees: ReadonlyArray<string>;
  }>({ labels: [], assignees: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const canWrite = useAtomValue(
    issueEnvironment.create.permissionAtom(scope?.environmentId ?? null),
  );
  const connected = usePullRequestConnected(scope?.environmentId ?? "");
  const templatesQuery = useEnvironmentQuery(
    scope !== null && scope.templates
      ? issueEnvironment.templates({ environmentId: scope.environmentId, input: scope.scope })
      : null,
  );
  const templates = templatesQuery.data?.templates ?? [];
  const blankAllowed = templatesQuery.data?.blankIssuesEnabled ?? true;

  const chooseTemplate = (key: string) => {
    setTemplateKey(key);
    const template = templates.find((entry) => entry.key === key);
    if (!template) {
      setExtras({ labels: [], assignees: [] });
      return;
    }
    // A template is a starting point: it only overwrites what the writer has not typed yet.
    if (title.trim().length === 0) setTitle(template.title);
    if (body.trim().length === 0) setBody(template.body);
    setExtras({ labels: template.labels, assignees: template.assignees });
  };

  const blocked =
    scope === null
      ? scopesPending
        ? "Looking for trackers…"
        : "No project here can file issues."
      : !connected
        ? "Reconnect to file an issue."
        : !canWrite
          ? "This device isn't allowed to change source control on this environment."
          : !blankAllowed && templateKey === BLANK && templates.length > 0
            ? "This tracker requires a template."
            : null;

  const submit = async () => {
    const trimmedTitle = title.trim();
    if (scope === null || blocked !== null || trimmedTitle.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await create({
      environmentId: scope.environmentId,
      input: {
        ...scope.scope,
        title: trimmedTitle,
        body,
        labels: extras.labels,
        assignees: extras.assignees,
      },
    });
    inFlight.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      setError(issueCommandError(result));
      return;
    }
    const created: IssueParams = {
      environmentId: scope.environmentId,
      projectId: scope.scope.projectId,
      tracker: scope.scope.tracker,
      ...(scope.scope.host ? { host: scope.scope.host } : {}),
      scope: scope.scope.scope,
      issueKey: result.value.key,
    };
    refreshIssueLists(scope.environmentId);
    navigation.dispatch(StackActions.replace("Issue", created));
  };

  return (
    <PullRequestSheetContent
      busy={busy}
      title="New issue"
      subtitle={scope ? scope.scope.scope : "No tracker"}
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={busy ? "Creating…" : "Create issue"}
          loading={busy}
          disabled={blocked !== null || title.trim().length === 0}
          onPress={() => void submit()}
        />
      }
    >
      {scopes.length > 1 && scope ? (
        <PickerRow
          label="Project"
          value={`${scope.projectTitle} · ${scope.scope.scope}`}
          selected={String(scopeIndex)}
          options={scopes.map((entry, index) => ({
            id: String(index),
            title: `${entry.projectTitle} · ${entry.scope.scope}`,
          }))}
          onSelect={(id) => {
            setScopeIndex(Number(id));
            setTemplateKey(BLANK);
            setExtras({ labels: [], assignees: [] });
          }}
        />
      ) : null}
      {scope?.templates && (templates.length > 0 || templatesQuery.isPending) ? (
        <PickerRow
          label="Template"
          value={
            templatesQuery.isPending
              ? "Loading templates…"
              : (templates.find((entry) => entry.key === templateKey)?.name ?? "Blank issue")
          }
          selected={templateKey}
          disabled={templatesQuery.isPending}
          options={[
            ...(blankAllowed ? [{ id: BLANK, title: "Blank issue" }] : []),
            ...templates.map((template) => ({ id: template.key, title: template.name })),
          ]}
          onSelect={chooseTemplate}
        />
      ) : null}
      <TextInput
        autoFocus
        editable={!busy}
        accessibilityLabel="Issue title"
        placeholder="A short summary"
        placeholderTextColorClassName="accent-foreground-muted"
        maxLength={1024}
        value={title}
        onChangeText={setTitle}
        returnKeyType="next"
        className="min-h-12 rounded-[20px] bg-grouped-card px-4 text-base text-foreground"
      />
      <TextInput
        multiline
        editable={!busy}
        accessibilityLabel="Issue description"
        placeholder="Write in Markdown…"
        placeholderTextColorClassName="accent-foreground-muted"
        maxLength={65536}
        value={body}
        onChangeText={setBody}
        className="min-h-48 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      {extras.labels.length > 0 || extras.assignees.length > 0 ? (
        <View className="gap-1">
          {extras.labels.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              Labels: {extras.labels.join(", ")}
            </Text>
          ) : null}
          {extras.assignees.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              Assignees: {extras.assignees.join(", ")}
            </Text>
          ) : null}
        </View>
      ) : null}
      {blocked ? <Text className="text-xs text-foreground-muted">{blocked}</Text> : null}
      {error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </PullRequestSheetContent>
  );
}
