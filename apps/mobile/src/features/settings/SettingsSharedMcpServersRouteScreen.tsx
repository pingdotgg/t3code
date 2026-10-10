import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  parseSharedMcpServerDraft,
  sharedMcpServerDraft,
  upsertSharedMcpServer,
  type SharedMcpServerDraft,
} from "@t3tools/client-runtime/state/shared-mcp-servers";
import type { SharedMcpServer } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useRef, useState } from "react";
import { Alert, Linking, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

const EMPTY_DRAFT: SharedMcpServerDraft = { name: "", url: "", headers: "" };

export function SettingsSharedMcpServersRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Shared MCP servers" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Use the filter above to select a connected environment.
            </Text>
          ) : (
            selectedTargets.map((environment) => (
              <SharedMcpServersSection key={environment.environmentId} environment={environment} />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

/** One environment's saved servers. Every write sends the whole list back. */
function SharedMcpServersSection({ environment }: { readonly environment: SettingsTarget }) {
  const environmentId = environment.environmentId;
  const servers = environment.serverConfig.settings.sharedMcpServers;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "shared MCP servers update",
    reportFailure: true,
  });
  const [form, setForm] = useState<{
    readonly editing: SharedMcpServer | undefined;
    readonly draft: SharedMcpServerDraft;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function write(next: ReadonlyArray<SharedMcpServer>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await updateSettings({
      environmentId,
      input: { patch: { sharedMcpServers: next } },
    });
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) setError("Could not save shared MCP servers.");
    return false;
  }

  const save = () => {
    if (form === null) return;
    const parsed = parseSharedMcpServerDraft(servers, form.draft, form.editing);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    void write(upsertSharedMcpServer(servers, parsed.server, form.editing)).then((saved) => {
      if (saved) setForm(null);
    });
  };

  const confirmRemove = (server: SharedMcpServer) =>
    Alert.alert(
      `Remove ${server.name}?`,
      `New agent sessions on ${environment.label} stop getting it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void write(servers.filter((entry) => entry.name !== server.name)),
        },
      ],
    );

  return (
    <SettingsSection title={environment.label}>
      {servers.length === 0 && form === null ? (
        <Text className="p-4 text-sm text-foreground-muted">
          Add a server once and every new agent session on this environment gets it: Claude, Codex,
          Cursor, OpenCode, Pi, and ACP agents. Point it at a local MCP gateway to share many
          servers at once.
        </Text>
      ) : null}
      {servers.map((server, index) => (
        <SharedMcpServerRow
          // Any saved change, headers included, clears a stale Test result.
          key={JSON.stringify(server)}
          environmentId={environmentId}
          server={server}
          separated={index > 0}
          disabled={pending || form !== null}
          onEnabledChange={(enabled) =>
            void write(
              servers.map((entry) => (entry.name === server.name ? { ...entry, enabled } : entry)),
            )
          }
          onEdit={() => {
            setError(null);
            setForm({ editing: server, draft: sharedMcpServerDraft(server) });
          }}
          onRemove={() => confirmRemove(server)}
        />
      ))}
      {form !== null ? (
        <View className="gap-2 border-t border-border-subtle p-4">
          <Text className="text-lg font-semibold text-foreground">
            {form.editing ? `Edit ${form.editing.name}` : "New MCP server"}
          </Text>
          <AppTextInput
            accessibilityLabel="Server name"
            placeholder="gateway"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            value={form.draft.name}
            onChangeText={(name) => setForm({ ...form, draft: { ...form.draft, name } })}
          />
          <AppTextInput
            accessibilityLabel="Server URL"
            placeholder="http://127.0.0.1:3050/mcp"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!pending}
            value={form.draft.url}
            onChangeText={(url) => setForm({ ...form, draft: { ...form.draft, url } })}
          />
          <AppTextInput
            accessibilityLabel="Headers"
            placeholder="Authorization: Bearer …"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            editable={!pending}
            className="min-h-24"
            value={form.draft.headers}
            onChangeText={(headers) => setForm({ ...form, draft: { ...form.draft, headers } })}
          />
          <Text className="text-sm text-foreground-muted">
            One header per line, as Name: value. Leave •••••• to keep a saved value.
          </Text>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="px-4 pb-4 text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {form !== null ? (
        <>
          <SettingsActionRow
            icon="checkmark"
            label={form.editing ? "Save" : "Add server"}
            disabled={pending}
            loading={pending}
            onPress={save}
          />
          <SettingsActionRow
            icon="xmark"
            label="Cancel"
            disabled={pending}
            onPress={() => {
              setError(null);
              setForm(null);
            }}
          />
        </>
      ) : (
        <SettingsActionRow
          icon="plus"
          label="Add server"
          disabled={pending}
          onPress={() => {
            setError(null);
            setForm({ editing: undefined, draft: EMPTY_DRAFT });
          }}
        />
      )}
    </SettingsSection>
  );
}

function SharedMcpServerRow(props: {
  readonly environmentId: SettingsTarget["environmentId"];
  readonly server: SharedMcpServer;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const { server } = props;
  const testServer = useAtomCommand(serverEnvironment.testSharedMcpServer, {
    label: "shared MCP server test",
    reportFailure: false,
  });
  const signInServer = useAtomCommand(serverEnvironment.signInSharedMcpServer, {
    label: "shared MCP server sign-in",
    reportFailure: false,
  });
  // The provider sends the browser back to this environment's server, which
  // keeps the tokens.
  const connection = usePreparedConnection(props.environmentId);
  const redirectBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ readonly ok: boolean; readonly message: string } | null>(
    null,
  );
  const headerCount = Object.keys(server.headers).length;

  const test = () => {
    setTesting(true);
    setResult(null);
    void testServer({ environmentId: props.environmentId, input: { name: server.name } })
      .then((outcome) => {
        if (outcome._tag === "Success") {
          const { serverName, toolCount } = outcome.value;
          const tools = `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
          setResult({
            ok: true,
            message: serverName ? `Connected: ${serverName} · ${tools}` : `Connected · ${tools}`,
          });
        } else if (!isAtomCommandInterrupted(outcome)) {
          const failure = squashAtomCommandFailure(outcome);
          setResult({
            ok: false,
            message: failure instanceof Error ? failure.message : "Could not reach the server.",
          });
        }
      })
      .finally(() => setTesting(false));
  };

  const signIn = () => {
    if (redirectBaseUrl === null) return;
    setTesting(true);
    setResult(null);
    void signInServer({
      environmentId: props.environmentId,
      input: { name: server.name, redirectBaseUrl },
    })
      .then((outcome) => {
        if (outcome._tag === "Success") {
          const { authorizationUrl } = outcome.value;
          if (authorizationUrl === null) {
            setResult({ ok: true, message: "Connected · no sign-in needed" });
            return;
          }
          setResult({
            ok: true,
            message: "Finish signing in in your browser, then test the connection.",
          });
          void Linking.openURL(authorizationUrl).catch(() =>
            setResult({ ok: false, message: "Could not open the sign-in page." }),
          );
        } else if (!isAtomCommandInterrupted(outcome)) {
          const failure = squashAtomCommandFailure(outcome);
          setResult({
            ok: false,
            message: failure instanceof Error ? failure.message : "Could not start the sign-in.",
          });
        }
      })
      .finally(() => setTesting(false));
  };

  return (
    <View className={props.separated ? "border-t border-border-subtle" : undefined}>
      <SettingsSwitchRow
        icon="server.rack"
        label={server.name}
        subtitle={
          headerCount > 0
            ? `${server.url} · ${headerCount} ${headerCount === 1 ? "header" : "headers"}`
            : server.url
        }
        value={server.enabled}
        disabled={props.disabled}
        onValueChange={props.onEnabledChange}
      />
      <View className="flex-row flex-wrap gap-2 px-4 pb-4">
        <ServerAction
          label={testing ? "Testing…" : "Test"}
          disabled={props.disabled || testing}
          onPress={test}
        />
        <ServerAction
          label="Sign in"
          disabled={props.disabled || testing || redirectBaseUrl === null}
          onPress={signIn}
        />
        <ServerAction label="Edit" disabled={props.disabled} onPress={props.onEdit} />
        <ServerAction label="Remove" danger disabled={props.disabled} onPress={props.onRemove} />
      </View>
      {result ? (
        <Text
          accessibilityLiveRegion="polite"
          className={
            result.ok
              ? "px-4 pb-4 text-sm text-foreground-muted"
              : "px-4 pb-4 text-sm text-danger-foreground"
          }
        >
          {result.message}
        </Text>
      ) : null}
    </View>
  );
}

function ServerAction(props: {
  readonly label: string;
  readonly danger?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-full bg-subtle px-4 py-2 active:opacity-70 disabled:opacity-40"
    >
      <Text
        className={
          props.danger
            ? "text-sm font-t3-medium text-danger-foreground"
            : "text-sm font-t3-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
