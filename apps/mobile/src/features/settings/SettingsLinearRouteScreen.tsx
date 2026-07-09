import { useNavigation } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { LinearIcon } from "../../components/LinearIcon";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentServerConfig } from "../../state/entities";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const LINEAR_KEY_HELP = "Linear → Settings → Security & access → Personal API keys";

export function SettingsLinearRouteScreen() {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const environmentId = environments[0]?.environmentId ?? null;

  const authQuery = useEnvironmentQuery(
    environmentId === null ? null : linearEnvironment.authStatus({ environmentId, input: {} }),
  );
  const setToken = useAtomCommand(linearEnvironment.setToken, { reportFailure: false });
  const clearToken = useAtomCommand(linearEnvironment.clearToken, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const config = useEnvironmentServerConfig(environmentId);
  const linear = config?.settings?.linear;

  const [token, setTokenValue] = useState("");
  const [busy, setBusy] = useState(false);

  const connected = authQuery.data?.status === "authenticated";
  const account = authQuery.data?.account;

  const handleConnect = useCallback(async () => {
    const trimmed = token.trim();
    if (environmentId === null || trimmed.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await setToken({ environmentId, input: { token: trimmed } });
      if (result._tag === "Success" && result.value.status === "authenticated") {
        setTokenValue("");
        authQuery.refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [authQuery, busy, environmentId, setToken, token]);

  const handleDisconnect = useCallback(async () => {
    if (environmentId === null || busy) return;
    setBusy(true);
    try {
      await clearToken({ environmentId, input: {} });
      authQuery.refresh();
    } finally {
      setBusy(false);
    }
  }, [authQuery, busy, clearToken, environmentId]);

  const setSyncFlag = useCallback(
    (patch: Record<string, boolean>) => {
      if (environmentId === null) return;
      void updateSettings({ environmentId, input: { patch: { linear: patch } } });
    },
    [environmentId, updateSettings],
  );

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        contentContainerStyle={{
          gap: 24,
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: 48,
        }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsSection title="Connection">
          <View className="gap-3 p-4">
            <View className="flex-row items-center gap-2">
              <LinearIcon size={18} />
              <Text className="text-base text-foreground-muted">
                {connected
                  ? `Connected as ${account?.name ?? "Linear account"}${
                      account?.email ? ` (${account.email})` : ""
                    }`
                  : "Not connected"}
              </Text>
            </View>
            {connected ? (
              <ConnectionSheetButton
                icon="xmark.circle"
                label={busy ? "Working…" : "Disconnect"}
                onPress={() => void handleDisconnect()}
                tone="danger"
              />
            ) : (
              <>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={environmentId !== null && !busy}
                  onChangeText={setTokenValue}
                  placeholder="lin_api_…"
                  secureTextEntry
                  value={token}
                />
                <ConnectionSheetButton
                  disabled={environmentId === null || busy || token.trim().length === 0}
                  icon="link"
                  label={busy ? "Connecting…" : "Connect"}
                  onPress={() => void handleConnect()}
                  tone="primary"
                />
                <Text className="text-sm text-foreground-tertiary">
                  Create a personal API key in {LINEAR_KEY_HELP}. The key is stored securely on the
                  server.
                </Text>
              </>
            )}
          </View>
        </SettingsSection>

        {connected ? (
          <SettingsSection title="Import">
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-4 p-4"
              onPress={() => navigation.navigate("LinearImport")}
            >
              <LinearIcon size={20} />
              <Text className="flex-1 text-lg text-foreground">Browse &amp; import issues</Text>
              <Text className="text-base text-foreground-muted">›</Text>
            </Pressable>
          </SettingsSection>
        ) : null}

        <SettingsSection title="Status write-back">
          <SettingsSwitchRow
            icon="arrow.triangle.2.circlepath"
            label="Auto-sync issue status"
            onValueChange={(value) => setSyncFlag({ autoSync: value })}
            value={linear?.autoSync ?? true}
          />
          <SettingsSwitchRow
            disabled={!(linear?.autoSync ?? true)}
            icon="play.circle"
            label="In Progress on start"
            onValueChange={(value) => setSyncFlag({ transitionOnStart: value })}
            value={linear?.transitionOnStart ?? true}
          />
          <SettingsSwitchRow
            disabled={!(linear?.autoSync ?? true)}
            icon="arrow.triangle.pull"
            label="In Review on pull request"
            onValueChange={(value) => setSyncFlag({ transitionOnPrOpen: value })}
            value={linear?.transitionOnPrOpen ?? true}
          />
          <SettingsSwitchRow
            disabled={!(linear?.autoSync ?? true)}
            icon="checkmark.circle"
            label="Done on merge"
            onValueChange={(value) => setSyncFlag({ transitionOnMerge: value })}
            value={linear?.transitionOnMerge ?? true}
          />
          <SettingsSwitchRow
            disabled={!(linear?.autoSync ?? true)}
            icon="bubble.left"
            label="Post progress comments"
            onValueChange={(value) => setSyncFlag({ postComments: value })}
            value={linear?.postComments ?? false}
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
