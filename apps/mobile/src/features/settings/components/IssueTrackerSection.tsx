import {
  boundIssueTrackerScopes,
  issueTrackerBindInput,
  issueTrackerBindingFor,
  issueTrackerBindings,
  issueTrackerScopeOptions,
  issueTrackerSummary,
} from "@t3tools/client-runtime/state/issue-trackers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueTrackerConnection,
  IssueTrackerConnectionList,
  ProjectId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Platform, View } from "react-native";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Menu } from "../../../components/ui/Menu";
import { SecretTextInput } from "../../../components/ui/SecretTextInput";
import { useProjects } from "../../../state/entities";
import { issueTrackerEnvironment } from "../../../state/issueTrackers";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsProviderRow } from "./SettingsProviderRow";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const UNBOUND = "";
const ThemedSvg = withUniwind(Svg);
const ICON_SIZE = Platform.OS === "android" ? 20 : 18;

/** Art per tracker kind; the server supplies everything else about a tracker. */
const TRACKER_MARKS: Partial<Record<string, string>> = {
  linear:
    "M1.225 61.523c-.222-.949.908-1.546 1.597-.857l36.512 36.512c.69.69.092 1.82-.857 1.597C20.15 94.612 5.388 79.85 1.225 61.523ZM.002 46.889a.99.99 0 0 0 .29.76l52.062 52.061a.99.99 0 0 0 .76.29c2.765-.169 5.47-.559 8.1-1.152.75-.169 1.014-1.084.47-1.63L2.784 38.32c-.545-.545-1.46-.28-1.63.47A50.229 50.229 0 0 0 .002 46.89ZM4.472 29.34a.99.99 0 0 0 .208 1.104l64.878 64.877a.99.99 0 0 0 1.104.208 50.293 50.293 0 0 0 5.807-3.132.99.99 0 0 0 .154-1.53L9.135 23.38a.99.99 0 0 0-1.53.154 50.29 50.29 0 0 0-3.132 5.807ZM12.293 18.229c-.309-.309-.334-.803-.045-1.13C21.376 6.626 34.637 0 49.45 0 76.869 0 99.1 22.231 99.1 49.65c0 14.813-6.626 28.074-17.099 37.202-.327.29-.821.264-1.13-.045L12.293 18.23Z",
};

/**
 * Standalone issue trackers, such as Linear, for each selected environment: connect one with a
 * credential, then pick which of its scopes each project lists beside its repository's issues.
 */
export function IssueTrackerSection(props: { readonly environments: readonly SettingsTarget[] }) {
  const gt = useGT();
  return (
    <>
      {props.environments.map((environment) =>
        environment.serverConfig.environment.capabilities.issues === true ? (
          <EnvironmentTrackers
            key={environment.environmentId}
            environment={environment}
            title={
              props.environments.length > 1
                ? gt("Issue trackers · {environment}", { environment: environment.label })
                : gt("Issue trackers")
            }
          />
        ) : null,
      )}
    </>
  );
}

function EnvironmentTrackers(props: {
  readonly environment: SettingsTarget;
  readonly title: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const { environmentId } = props.environment;
  const query = useEnvironmentQuery(
    issueTrackerEnvironment.connections({ environmentId, input: {} }),
  );
  const firstAccounts = query.data?.trackers ?? [];
  const trackers = firstAccounts.flatMap((tracker) => [
    tracker,
    ...(query.data?.accounts ?? []).filter((account) => account.tracker === tracker.tracker),
  ]);
  if (trackers.length === 0) {
    return query.error ? (
      <SettingsSection title={props.title} footer={query.error}>
        <View className="p-4">
          <Button label={gt("Try again")} tone="secondary" onPress={query.refresh} />
        </View>
      </SettingsSection>
    ) : null;
  }
  return (
    <SettingsSection title={props.title}>
      {trackers.map((tracker, index) => (
        <SettingsProviderRow
          key={`${tracker.tracker}-${tracker.accountId ?? ""}`}
          icon={<IssueTrackerMark tracker={tracker.tracker} />}
          label={
            tracker.workspace
              ? `${tracker.displayName} · ${tracker.workspace}`
              : tracker.displayName
          }
          description={issueTrackerSummary(tracker, issueTrackerBindings(query.data), messages)}
          ready={tracker.connected && tracker.account !== null}
          separated={index > 0}
          onPress={() =>
            navigation.navigate("SettingsIssueTracker", {
              environmentId,
              tracker: tracker.tracker,
              ...(tracker.accountId === undefined ? {} : { accountId: tracker.accountId }),
            })
          }
        />
      ))}
    </SettingsSection>
  );
}

export function IssueTrackerMark(props: { readonly tracker: string }) {
  const mark = TRACKER_MARKS[props.tracker];
  return mark ? (
    <ThemedSvg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 100 100"
      colorClassName="accent-icon"
    >
      <Path fill="currentColor" d={mark} />
    </ThemedSvg>
  ) : (
    <SymbolView name="circle.dashed" size={ICON_SIZE} tintColorClassName="accent-icon" />
  );
}

/** The credential field for one tracker, with what replaces, removes or creates it. */
export function IssueTrackerCredentialForm(props: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly disabled: boolean;
  /** Saves the credential as a new account instead of replacing this one's. */
  readonly addAccount?: boolean;
}) {
  const gt = useGT();
  const { environmentId, tracker } = props;
  const connect = useAtomCommand(issueTrackerEnvironment.connect, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async (token: string | null) => {
    setBusy(true);
    setFailure(null);
    const result = await connect({
      environmentId,
      input: props.addAccount
        ? { tracker: tracker.tracker, token, addAccount: true }
        : { tracker: tracker.tracker, accountId: tracker.accountId, token },
    });
    setBusy(false);
    if (!AsyncResult.isFailure(result)) {
      setDraft("");
      return;
    }
    const error = squashAtomCommandFailure(result);
    setFailure(error instanceof Error ? error.message : gt("The request failed."));
  };
  const helpUrl = tracker.credential.helpUrl;
  const locked = props.disabled || busy;
  const replacing = tracker.connected && !props.addAccount;
  return (
    <View className="gap-3 p-4">
      <SecretTextInput
        accessibilityLabel={tracker.credential.label}
        placeholder={
          replacing ? gt("Saved. Enter a new value to replace it") : tracker.credential.label
        }
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={(value) => {
          if (value.trim()) void submit(value.trim());
        }}
        editable={!locked}
      />
      {failure ? (
        <Text selectable className="text-xs text-danger-foreground">
          {failure}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap justify-end gap-2">
        {helpUrl ? (
          <Button
            label={gt("Create one")}
            tone="text"
            size="compact"
            onPress={() => void tryOpenExternalUrl(helpUrl)}
          />
        ) : null}
        {replacing ? (
          <Button
            label={gt("Disconnect")}
            tone="secondary"
            size="compact"
            disabled={locked}
            onPress={() => void submit(null)}
          />
        ) : null}
        <Button
          label={
            replacing
              ? gt("Replace", { $context: "verb, replaces a saved credential" })
              : gt("Connect", { $context: "verb, connects an issue tracker" })
          }
          tone="primary"
          size="compact"
          loading={busy}
          disabled={locked || !draft.trim()}
          onPress={() => void submit(draft.trim())}
        />
      </View>
    </View>
  );
}

/** One row per project of the environment: which of the tracker's scopes it reads, if any. */
export function IssueTrackerProjectRows(props: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly bindings: IssueTrackerConnectionList["bindings"];
  readonly refreshing: boolean;
  readonly refreshFailed: boolean;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const { environmentId, tracker } = props;
  const bind = useAtomCommand(issueTrackerEnvironment.bindProject, {
    label: `bind project to ${tracker.displayName}`,
  });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [picks, setPicks] = useState<Partial<Record<ProjectId, ReadonlyArray<string>>>>({});
  const [saving, setSaving] = useState(false);
  const held = Object.values(picks).some((scopes) => scopes !== undefined);
  if (held && !saving && !props.refreshing && !props.refreshFailed) setPicks({});
  const busy = saving || (held && props.refreshing);
  const bound = (projectId: ProjectId) =>
    picks[projectId] ?? boundIssueTrackerScopes(tracker, props.bindings[projectId]);
  const change = async (projectId: ProjectId, scopes: ReadonlyArray<string>) => {
    if (props.disabled || busy) return;
    const binding = issueTrackerBindingFor(tracker, bound(projectId), scopes);
    const before = picks[projectId];
    setSaving(true);
    setPicks((current) => ({
      ...current,
      [projectId]: boundIssueTrackerScopes(tracker, binding ?? undefined),
    }));
    const result = await bind({
      environmentId,
      input: issueTrackerBindInput(projectId, tracker, binding),
    });
    if (result._tag !== "Success") setPicks((current) => ({ ...current, [projectId]: before }));
    setSaving(false);
  };
  return projects.map((project) => {
    // A project bound to another tracker or account keeps that binding; this row shows it unbound.
    const value = bound(project.id);
    const options = issueTrackerScopeOptions(tracker, value);
    const toggle = (key: string) =>
      key === UNBOUND
        ? []
        : value.includes(key)
          ? value.filter((scope) => scope !== key)
          : [...value, key];
    const locked = props.disabled || busy;
    return (
      <Menu
        key={project.id}
        title={gt("{tracker} {scope} for {project}", {
          tracker: tracker.displayName,
          scope: tracker.scopeNoun,
          project: project.title,
        })}
        actions={[
          {
            id: UNBOUND,
            title: gt("Not bound"),
            state: value.length === 0 ? "on" : "off",
            attributes: { disabled: locked },
          },
          ...options.map((scope) => ({
            id: scope.key,
            title: `${scope.name} (${scope.key})`,
            state: value.includes(scope.key) ? ("on" as const) : ("off" as const),
            attributes: { disabled: locked || !scope.addable },
          })),
        ]}
        onPressAction={({ nativeEvent }) => void change(project.id, toggle(nativeEvent.event))}
      >
        <SettingsRow
          icon="folder"
          label={project.title}
          valuePosition="trailing"
          value={
            value.length === 0
              ? gt("Not bound")
              : value
                  .map((key) => tracker.scopes.find((scope) => scope.key === key)?.name ?? key)
                  .join(", ")
          }
          disabled={locked}
        />
      </Menu>
    );
  });
}
