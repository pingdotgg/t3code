import { defineNativePluginFeature } from "../../plugins/features";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react-native";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { nativePluginAtoms } from "../../plugins/state";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
const EnvironmentPlugins = defineNativePluginFeature(
  "native.features.settings.settings-plugins-route-screen.environment-plugins",
  BuiltinEnvironmentPlugins,
);

function BuiltinSettingsPluginsRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <SettingsScreen title={gt("Plugins")} menus={[environmentMenu]}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-base text-foreground-muted">
            <T>Connect an environment to manage its plugins.</T>
          </Text>
        ) : (
          selectedTargets.map((target) =>
            target.serverConfig.environment.capabilities.plugins === true ? (
              <EnvironmentPlugins
                key={target.environmentId}
                environmentId={target.environmentId}
                label={target.label}
              />
            ) : (
              <SettingsSection key={target.environmentId} title={target.label}>
                <Text className="p-4 text-base text-foreground-muted">
                  <T>Update this environment to manage plugins.</T>
                </Text>
              </SettingsSection>
            ),
          )
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function BuiltinEnvironmentPlugins({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const snapshot = useAtomValue(nativePluginAtoms.snapshotAtom(environmentId));
  const catalog = useAtomValue(nativePluginAtoms.catalog({ environmentId, input: {} }));
  const matchingEntries = AsyncResult.isSuccess(catalog)
    ? catalog.value.entries.filter((entry) =>
        `${entry.manifest.name} ${entry.manifest.id} ${entry.manifest.description ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : [];
  const setEnabled = useAtomCommand(nativePluginAtoms.setEnabled);
  const reload = useAtomCommand(nativePluginAtoms.reload);
  const install = useAtomCommand(nativePluginAtoms.install);
  const [pending, setPending] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (id: string, action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(id);
    setError(null);
    await Promise.resolve()
      .then(action)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        inFlight.current = false;
        setPending(null);
      });
  };
  return (
    <SettingsSection title={label}>
      <SettingsActionRow
        icon="arrow.clockwise"
        label={gt("Reload local plugins")}
        disabled={pending !== null}
        loading={pending === "reload"}
        onPress={() =>
          void run("reload", async () => {
            const result = await reload({ environmentId, input: {} });
            if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
          })
        }
      />
      {AsyncResult.isSuccess(snapshot) ? (
        snapshot.value.plugins.map((plugin) => (
          <View key={plugin.manifest.id}>
            <SettingsSwitchRow
              icon="square.grid.2x2"
              label={plugin.manifest.name}
              subtitle={
                plugin.source === "builtin"
                  ? gt("Bundled feature")
                  : `${plugin.manifest.version} · ${plugin.status}`
              }
              value={plugin.enabled}
              disabled={
                pending !== null ||
                (plugin.source === "builtin" && !plugin.manifest.id.startsWith("t3.provider."))
              }
              onValueChange={(enabled) =>
                void run(plugin.manifest.id, async () => {
                  const result = await setEnabled({
                    environmentId,
                    input: { id: plugin.manifest.id, enabled },
                  });
                  if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                })
              }
            />
            {plugin.error ? (
              <Text className="px-4 pb-4 text-sm text-danger-foreground">{plugin.error}</Text>
            ) : null}
          </View>
        ))
      ) : (
        <Text className="p-4 text-base text-foreground-muted">
          {AsyncResult.isFailure(snapshot) ? (
            <T>This environment could not load its plugin catalog.</T>
          ) : (
            <T>Loading plugins...</T>
          )}
        </Text>
      )}
      {error ? <Text className="p-4 text-sm text-danger-foreground">{error}</Text> : null}
      <TextInput
        accessibilityLabel={gt("Search plugins in {label}", { label })}
        placeholder={gt("Search available plugins")}
        placeholderTextColorClassName="accent-foreground-muted"
        className="px-4 py-3 text-base text-foreground"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {AsyncResult.isSuccess(catalog)
        ? matchingEntries.map((entry) => {
            const installed =
              AsyncResult.isSuccess(snapshot) &&
              snapshot.value.plugins.some((plugin) => plugin.manifest.id === entry.manifest.id);
            return (
              <View key={entry.manifest.id}>
                <Text className="px-4 pt-3 text-sm text-foreground-muted">
                  <T>
                    <Var>{entry.publisher.name}</Var> · Reviewed by{" "}
                    <Var>{entry.review.reviewer}</Var>
                  </T>
                </Text>
                <SettingsActionRow
                  icon="square.grid.2x2"
                  label={
                    installed
                      ? gt("{name} is installed", { name: entry.manifest.name })
                      : gt("Install {name}", { name: entry.manifest.name })
                  }
                  disabled={installed || pending !== null}
                  loading={pending === `install:${entry.manifest.id}`}
                  onPress={() =>
                    void run(`install:${entry.manifest.id}`, async () => {
                      const result = await install({
                        environmentId,
                        input: { id: entry.manifest.id },
                      });
                      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                    })
                  }
                />
              </View>
            );
          })
        : null}
      {AsyncResult.isSuccess(catalog) && matchingEntries.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          <T>No available plugins match this search.</T>
        </Text>
      ) : null}
      {AsyncResult.isFailure(catalog) ? (
        <Text className="p-4 text-sm text-danger-foreground">
          <T>The available plugin catalog could not be loaded.</T>
        </Text>
      ) : null}
    </SettingsSection>
  );
}

export const SettingsPluginsRouteScreen = defineNativePluginFeature(
  "settings.plugins",
  BuiltinSettingsPluginsRouteScreen,
);
