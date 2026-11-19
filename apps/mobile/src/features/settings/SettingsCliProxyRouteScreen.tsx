import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SelectionRow } from "./SettingsOptimizersRouteScreen";

export function SettingsCliProxyRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [environmentSelection, setEnvironmentSelection] = useState<EnvironmentId | null>(null);
  const selectedEnvironment =
    environments.find((item) => item.environmentId === environmentSelection) ??
    environments[0] ??
    null;
  const environmentId = selectedEnvironment?.environmentId ?? null;
  const connected = selectedEnvironment?.connection.phase === "connected";
  const status = useEnvironmentQuery(
    environmentId !== null && connected
      ? serverEnvironment.optimizersGetStatus({ environmentId, input: { refresh: true } })
      : null,
  );

  const canManageCpa = useAtomValue(serverEnvironment.setCpaRouting.permissionAtom(environmentId));
  const startCpa = useAtomCommand(serverEnvironment.startCpa, {
    label: "CLIProxyAPI start",
    reportFailure: false,
  });
  const setCpaRouting = useAtomCommand(serverEnvironment.setCpaRouting, {
    label: "CLIProxyAPI routing",
    reportFailure: false,
  });
  const [cpaBusy, setCpaBusy] = useState(false);
  const cpa = status.data?.cpa;

  const runCpaCommand = async (run: () => ReturnType<typeof startCpa>, title: string) => {
    if (!connected || !canManageCpa || cpaBusy) return;
    setCpaBusy(true);
    const result = await run().finally(() => setCpaBusy(false));
    if (result._tag === "Success") {
      status.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      Alert.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <SettingsScreen title="CLIProxyAPI">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedEnvironment ? (
          <>
            <SettingsSection title="Scope">
              <SelectionRow
                label="Environment"
                value={`${selectedEnvironment.label} · ${selectedEnvironment.connection.phase}`}
                actions={environments.map((item) => ({
                  id: item.environmentId,
                  title: item.label,
                  subtitle: item.connection.phase,
                  state: item.environmentId === environmentId ? "on" : "off",
                }))}
                onSelect={(id) => setEnvironmentSelection(EnvironmentId.make(id))}
              />
            </SettingsSection>

            {cpa && environmentId ? (
              <SettingsSection title="CLIProxyAPI (CPA)">
                <View className="flex-row items-start gap-3 p-4">
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-t3-medium text-foreground">CLIProxyAPI</Text>
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {cpa.running ? "Running" : "Not running"} · {cpa.url}
                    </Text>
                  </View>
                  {!cpa.running && cpa.canStart ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={cpaBusy ? "Starting CLIProxyAPI" : "Start CLIProxyAPI"}
                      disabled={!connected || cpaBusy || !canManageCpa}
                      onPress={() =>
                        void runCpaCommand(
                          () => startCpa({ environmentId, input: {} }),
                          "Could not start CLIProxyAPI",
                        )
                      }
                      className="rounded-lg border border-border-subtle px-3 py-2 active:opacity-70 disabled:opacity-40"
                    >
                      <Text className="text-sm font-t3-medium text-foreground">
                        {cpaBusy ? "Starting…" : "Start"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                <SettingsSwitchRow
                  icon="arrow.triangle.branch"
                  label="Route Claude Code and Codex through CPA"
                  subtitle={
                    cpa.routing === "partial"
                      ? "Partly on: only one of Claude Code or Codex routes through CPA"
                      : "Rewrites the host's Claude and Codex CLI config"
                  }
                  value={cpa.routing === "on"}
                  disabled={!connected || cpaBusy || !canManageCpa}
                  onValueChange={(enabled) =>
                    void runCpaCommand(
                      () => setCpaRouting({ environmentId, input: { enabled } }),
                      "Could not change CPA routing",
                    )
                  }
                />
                {cpa.headroomUpstreamMismatch ? (
                  <Text className="border-t border-border-subtle p-4 text-xs text-warning-foreground">
                    Headroom was started outside T3, so it is not pointed at CPA. Restart it with
                    --anthropic-api-url {cpa.url} --openai-api-url {cpa.url}/v1.
                  </Text>
                ) : null}
              </SettingsSection>
            ) : (
              <SettingsSection title="CLIProxyAPI (CPA)">
                <Text className="p-4 text-sm text-foreground-muted">
                  {!connected
                    ? "Reconnect this environment to check its CLIProxyAPI."
                    : status.error
                      ? status.error
                      : status.isPending
                        ? "Checking CLIProxyAPI…"
                        : "This environment does not report a CLIProxyAPI proxy."}
                </Text>
              </SettingsSection>
            )}
          </>
        ) : (
          <SettingsSection title="CLIProxyAPI (CPA)">
            <Text className="p-4 text-sm text-foreground-muted">
              Connect an environment to check its CLIProxyAPI.
            </Text>
          </SettingsSection>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
