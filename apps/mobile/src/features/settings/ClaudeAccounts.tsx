import type { MenuAction } from "@react-native-menu/menu";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isManagedSettingPath,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Menu } from "../../components/ui/Menu";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  claudeConfigDir,
  DEFAULT_CLAUDE_INSTANCE_ID,
  planClaudeAccountSave,
  type ClaudeAccountDraft,
} from "./claude-accounts";
import type { SettingsTarget } from "./settings-environment-filter";

function useProviderInstanceMutation(environment: SettingsTarget) {
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(providerInstanceMutation: ProviderInstanceMutation) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await mutate({
      environmentId: environment.environmentId,
      input: { patch: {}, providerInstanceMutation },
    });
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save the Claude account.");
    }
    return false;
  }
  return { run, pending, error, setError };
}

export function ClaudeAccount({
  environment,
  provider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const [editing, setEditing] = useState(false);
  const { run, pending, error } = useProviderInstanceMutation(environment);
  const instance = environment.serverConfig.settings.providerInstances[provider.instanceId];
  const configDir = claudeConfigDir(instance);
  const name = provider.displayName ?? "Claude";
  const status = !provider.enabled
    ? "Turned off"
    : provider.auth.status === "authenticated"
      ? "Signed in"
      : provider.auth.status === "unauthenticated"
        ? "Not signed in"
        : !provider.installed
          ? "Not installed"
          : null;
  const removable =
    provider.instanceId !== DEFAULT_CLAUDE_INSTANCE_ID &&
    !isManagedSettingPath(
      environment.serverConfig.managedPolicy,
      `providerInstances.${provider.instanceId}`,
    );
  const actions: MenuAction[] = [
    { id: "edit", title: "Edit", image: "pencil" },
    ...(removable
      ? [
          {
            id: "remove",
            title: "Remove",
            image: "trash",
            attributes: { destructive: true },
          } satisfies MenuAction,
        ]
      : []),
  ];
  function remove() {
    Dialog.alert(
      `Remove ${name}?`,
      `It leaves the model picker on ${environment.label}. The config folder and its sign-in stay on the server.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void run({ operation: "remove", instanceId: provider.instanceId });
          },
        },
      ],
    );
  }
  return (
    <View className="border-t border-border-subtle">
      <View className="min-h-16 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 shrink grow gap-0.5">
          <Text textRole="body" className="text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
            {[status, configDir || "Default config folder"].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {editing ? null : (
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${name} options`}
            title={name}
            actions={actions}
            onPressAction={({ nativeEvent }) => {
              if (pending) return;
              if (nativeEvent.event === "edit") setEditing(true);
              else if (nativeEvent.event === "remove") remove();
            }}
          >
            <ControlPill
              icon="ellipsis"
              accessibilityLabel={`${name} options`}
              disabled={pending}
            />
          </Menu>
        )}
      </View>
      {editing ? (
        <ClaudeAccountForm
          environment={environment}
          instanceId={provider.instanceId}
          initial={{ name: instance?.displayName ?? "", configDir }}
          onDone={() => setEditing(false)}
        />
      ) : error ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function AddClaudeAccount({ environment }: { readonly environment: SettingsTarget }) {
  const [adding, setAdding] = useState(false);
  return (
    <View className="border-t border-border-subtle">
      {adding ? (
        <ClaudeAccountForm
          environment={environment}
          instanceId={null}
          initial={{ name: "", configDir: "" }}
          onDone={() => setAdding(false)}
        />
      ) : (
        <ListActionRow
          icon="plus"
          label="Add Claude account"
          description="Use a Claude config folder that is already signed in on this server."
          onPress={() => setAdding(true)}
        />
      )}
    </View>
  );
}

function ClaudeAccountForm({
  environment,
  instanceId,
  initial,
  onDone,
}: {
  readonly environment: SettingsTarget;
  readonly instanceId: ProviderInstanceId | null;
  readonly initial: ClaudeAccountDraft;
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const { run, pending, error, setError } = useProviderInstanceMutation(environment);
  function save() {
    const plan = planClaudeAccountSave({
      providerInstances: environment.serverConfig.settings.providerInstances,
      policy: environment.serverConfig.managedPolicy,
      instanceId,
      draft,
    });
    if ("error" in plan) {
      setError(plan.error);
      return;
    }
    void run(plan.mutation).then((saved) => {
      if (saved) onDone();
    });
  }
  function field(key: keyof ClaudeAccountDraft, label: string, placeholder: string) {
    return (
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!pending}
        value={draft[key]}
        onChangeText={(value) => setDraft((current) => ({ ...current, [key]: value }))}
      />
    );
  }
  return (
    <View className="gap-2 px-4 py-3">
      <Text textRole="footnote" className="text-foreground-muted">
        {`Point at a CLAUDE_CONFIG_DIR folder on ${environment.label} where Claude Code is already signed in. Sign in there with the Claude CLI first.`}
      </Text>
      {field("name", "Account name", "Name, e.g. Work")}
      {field("configDir", "Claude config folder", "Config folder, e.g. ~/.claude-work")}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row justify-end gap-2">
        <ControlPill variant="pill" label="Cancel" disabled={pending} onPress={onDone} />
        <ControlPill
          variant="primary"
          label={instanceId === null ? "Add" : "Save"}
          disabled={pending}
          onPress={save}
        />
      </View>
    </View>
  );
}
