import type { ComponentProps } from "react";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  DEFAULT_HEADROOM_PROXY_URL,
  EnvironmentId,
  ProjectId,
  type OptimizerId,
  type OptimizerStatus,
} from "@t3tools/contracts";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

const OPTIMIZER_IDS = ["rtk", "headroom", "cbm"] as const;
const OPTIMIZER_META: Readonly<
  Record<
    OptimizerId,
    {
      readonly label: string;
      readonly subtitle: string;
      readonly icon: ComponentProps<typeof SymbolView>["name"];
    }
  >
> = {
  rtk: {
    label: "RTK",
    subtitle: "Starts as a CLI wrapper inside supported sessions",
    icon: "terminal",
  },
  headroom: {
    label: "Headroom",
    subtitle: "Routes through the local proxy; start it from Host status",
    icon: "bolt.horizontal.circle",
  },
  cbm: {
    label: "Codebase Memory",
    subtitle: "Starts as stdio MCP inside supported sessions",
    icon: "cube",
  },
};

function SelectionRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: ComponentProps<typeof Menu>["actions"];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <Menu
      accessibilityLabel={props.label}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70">
        <SymbolView name="folder" size={20} tintColorClassName="accent-icon" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.value}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={13} tintColorClassName="accent-chevron" />
      </Pressable>
    </Menu>
  );
}

function statusLabel(status: OptimizerStatus | undefined): string {
  if (!status) return "Waiting for probe";
  if (!status.installed) return "Not installed";
  if (status.id === "headroom" && status.running !== true) return "Installed · not running";
  return status.version ? `Installed · v${status.version}` : "Installed";
}

export function SettingsOptimizersRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [environmentSelection, setEnvironmentSelection] = useState<EnvironmentId | null>(null);
  const [projectSelection, setProjectSelection] = useState<ProjectId | null>(null);
  const [savingOptimizer, setSavingOptimizer] = useState<OptimizerId | null>(null);
  const [proxyDraft, setProxyDraft] = useState<string | null>(null);
  const selectedEnvironment =
    environments.find((item) => item.environmentId === environmentSelection) ??
    environments[0] ??
    null;
  const environmentId = selectedEnvironment?.environmentId ?? null;
  const connected = selectedEnvironment?.connection.phase === "connected";
  const config = useEnvironmentServerConfig(environmentId);
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const selectedProject =
    environmentProjects.find((project) => project.id === projectSelection) ??
    environmentProjects[0] ??
    null;
  const status = useEnvironmentQuery(
    environmentId !== null && connected
      ? serverEnvironment.optimizersGetStatus({ environmentId, input: { refresh: true } })
      : null,
  );
  const statusById = useMemo(
    () => new Map(status.data?.optimizers.map((item) => [item.id, item]) ?? []),
    [status.data?.optimizers],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "optimizer settings update",
    reportFailure: true,
  });
  const canStartHeadroom = useAtomValue(
    serverEnvironment.startHeadroom.permissionAtom(environmentId),
  );
  const startHeadroom = useAtomCommand(serverEnvironment.startHeadroom, {
    label: "Headroom proxy start",
    reportFailure: false,
  });
  const [startingHeadroom, setStartingHeadroom] = useState(false);

  const startHeadroomProxy = async () => {
    if (!environmentId || !connected || !canStartHeadroom || startingHeadroom) return;
    setStartingHeadroom(true);
    // Atom commands settle to a result rather than rejecting.
    const result = await startHeadroom({ environmentId, input: {} }).finally(() =>
      setStartingHeadroom(false),
    );
    if (result._tag === "Success") {
      status.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      Alert.alert("Could not start Headroom", String(squashAtomCommandFailure(result)));
    }
  };

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

  const updateOptimizer = async (id: OptimizerId, enabled: boolean) => {
    if (!environmentId || !selectedProject || !connected || savingOptimizer !== null) return;
    setSavingOptimizer(id);
    await updateSettings({
      environmentId,
      input: { patch: { projectOptimizerOverrides: { [selectedProject.id]: { [id]: enabled } } } },
    });
    setSavingOptimizer(null);
    status.refresh();
  };

  const proxyUrl = config?.settings.headroomProxyUrl ?? DEFAULT_HEADROOM_PROXY_URL;
  const saveProxy = async () => {
    if (!environmentId || proxyDraft === null || !connected) return;
    const value = proxyDraft.trim();
    if (value === proxyUrl) {
      setProxyDraft(null);
      return;
    }
    const result = await updateSettings({
      environmentId,
      input: { patch: { headroomProxyUrl: value } },
    });
    if (result._tag === "Success") {
      setProxyDraft(null);
      status.refresh();
    }
  };

  return (
    <SettingsScreen title="Optimizers">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Optimizers run on the selected T3 environment. Project toggles apply to new provider
          sessions.
        </Text>
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
                onSelect={(id) => {
                  setEnvironmentSelection(EnvironmentId.make(id));
                  setProjectSelection(null);
                }}
              />
              {selectedProject ? (
                <SelectionRow
                  label="Project"
                  value={selectedProject.title}
                  actions={environmentProjects.map((project) => ({
                    id: project.id,
                    title: project.title,
                    subtitle: project.workspaceRoot,
                    state: project.id === selectedProject.id ? "on" : "off",
                  }))}
                  onSelect={(id) => setProjectSelection(ProjectId.make(id))}
                />
              ) : null}
            </SettingsSection>

            {selectedProject ? (
              <SettingsSection title="Project optimizers">
                {OPTIMIZER_IDS.map((id) => (
                  <SettingsSwitchRow
                    key={id}
                    icon={OPTIMIZER_META[id].icon}
                    label={OPTIMIZER_META[id].label}
                    subtitle={OPTIMIZER_META[id].subtitle}
                    value={
                      config?.settings.projectOptimizerOverrides[selectedProject.id]?.[id] ?? false
                    }
                    disabled={!connected || config === null || savingOptimizer !== null}
                    onValueChange={(enabled) => void updateOptimizer(id, enabled)}
                  />
                ))}
              </SettingsSection>
            ) : null}

            <SettingsSection title="Host status">
              {status.isPending && status.data === null ? (
                <View className="flex-row items-center gap-3 p-4">
                  <ActivityIndicator />
                  <Text className="text-sm text-foreground-muted">Checking optimizer status…</Text>
                </View>
              ) : status.error ? (
                <View className="gap-2 p-4">
                  <Text className="text-sm text-danger-foreground">{status.error}</Text>
                </View>
              ) : (
                OPTIMIZER_IDS.map((id) => {
                  const optimizer = statusById.get(id);
                  const detail =
                    optimizer?.detail ??
                    (id === "rtk"
                      ? "T3 starts the wrapper inside each supported provider session."
                      : id === "cbm"
                        ? "T3 starts CBM over stdio inside each supported provider session."
                        : undefined);
                  return (
                    <View
                      key={id}
                      className="flex-row items-start gap-3 border-t border-border-subtle p-4 first:border-t-0"
                    >
                      <View className="min-w-0 flex-1">
                        <Text className="text-sm font-t3-medium text-foreground">
                          {OPTIMIZER_META[id].label}
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {statusLabel(optimizer)}
                        </Text>
                        {detail ? (
                          <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={3}>
                            {detail}
                          </Text>
                        ) : null}
                      </View>
                      {id === "headroom" && optimizer?.installed && optimizer.running !== true ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            startingHeadroom ? "Starting Headroom" : "Start Headroom"
                          }
                          disabled={
                            !connected || status.isPending || startingHeadroom || !canStartHeadroom
                          }
                          onPress={() => void startHeadroomProxy()}
                          className="rounded-lg border border-border-subtle px-3 py-2 active:opacity-70 disabled:opacity-40"
                        >
                          <Text className="text-sm font-t3-medium text-foreground">
                            {startingHeadroom ? "Starting…" : "Start"}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })
              )}
              <Pressable
                accessibilityRole="button"
                disabled={!connected || status.isPending}
                onPress={status.refresh}
                className="border-t border-border-subtle p-4 active:opacity-70 disabled:opacity-40"
              >
                <Text className="text-sm font-t3-medium text-foreground">Refresh status</Text>
              </Pressable>
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
            ) : null}

            <SettingsSection title="Savings">
              {status.data?.savings.length ? (
                status.data.savings.map((saving) => (
                  <View
                    key={`${saving.source}:${saving.window}`}
                    className="flex-row justify-between border-t border-border-subtle p-4 first:border-t-0"
                  >
                    <Text className="text-sm text-foreground">
                      {OPTIMIZER_META[saving.source].label} · {saving.window}
                    </Text>
                    <Text className="text-sm tabular-nums text-foreground-muted">
                      {saving.tokensSaved.toLocaleString()} tokens
                    </Text>
                  </View>
                ))
              ) : (
                <Text className="p-4 text-sm text-foreground-muted">No savings reported yet.</Text>
              )}
            </SettingsSection>

            <SettingsSection title="Savings history">
              {status.data?.savingsHistory.length ? (
                [...status.data.savingsHistory]
                  .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
                  .slice(0, 8)
                  .map((point) => (
                    <View
                      key={`${point.interval}:${point.timestamp}`}
                      className="flex-row justify-between gap-3 border-t border-border-subtle p-4 first:border-t-0"
                    >
                      <View className="min-w-0 flex-1">
                        <Text className="text-sm text-foreground">Headroom · {point.interval}</Text>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          {new Date(point.timestamp).toLocaleString()}
                        </Text>
                      </View>
                      <Text className="text-sm tabular-nums text-foreground-muted">
                        {point.tokensSaved.toLocaleString()} tokens
                      </Text>
                    </View>
                  ))
              ) : (
                <Text className="p-4 text-sm text-foreground-muted">
                  No savings history reported yet.
                </Text>
              )}
            </SettingsSection>

            <SettingsSection title="Codebase Memory index">
              {status.data?.cbmIndexes.filter(
                (index) => selectedProject === null || index.projectId === selectedProject.id,
              ).length ? (
                status.data.cbmIndexes
                  .filter(
                    (index) => selectedProject === null || index.projectId === selectedProject.id,
                  )
                  .map((index) => (
                    <View
                      key={index.projectId}
                      className="border-t border-border-subtle p-4 first:border-t-0"
                    >
                      <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                        {index.repoPath}
                      </Text>
                      <Text className="text-xs text-foreground-muted">
                        {index.state}
                        {index.nodeCount !== undefined || index.edgeCount !== undefined
                          ? ` · ${index.nodeCount ?? 0} nodes · ${index.edgeCount ?? 0} edges`
                          : ""}
                      </Text>
                      {index.detail ? (
                        <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={3}>
                          {index.detail}
                        </Text>
                      ) : null}
                    </View>
                  ))
              ) : (
                <Text className="p-4 text-sm text-foreground-muted">
                  No index status reported for this project.
                </Text>
              )}
            </SettingsSection>

            <SettingsSection title="Headroom proxy">
              <View className="gap-2 p-4">
                <TextInput
                  accessibilityLabel="Headroom proxy URL"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={connected}
                  keyboardType="url"
                  value={proxyDraft ?? proxyUrl}
                  onBlur={() => void saveProxy()}
                  onChangeText={setProxyDraft}
                  onSubmitEditing={() => void saveProxy()}
                />
                <Text className="text-xs text-foreground-muted">
                  This loopback URL belongs to the selected environment. Start an installed proxy
                  from Host status; T3 does not install Headroom or change provider configuration.
                </Text>
              </View>
            </SettingsSection>
          </>
        ) : (
          <SettingsSection title="Optimizer status">
            <Text className="p-4 text-sm text-foreground-muted">
              Connect an environment to inspect optimizer status.
            </Text>
          </SettingsSection>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
