import { AuthSettingsWriteScope, isManagedSettingPath } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsNativeToolsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environmentMenu = useSettingsEnvironmentMenu();
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "T3 tool settings update",
    reportFailure: true,
  });
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  return (
    <SettingsScreen title="T3 tools" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 py-4"
      >
        <Text className="text-sm text-foreground-muted">
          Choose which built-in T3 tools agents can use across all providers. Disabled tools block
          new calls immediately. Reconnect existing agent sessions to refresh their tool lists.
          Calls already running are not cancelled.
        </Text>
        <TextInput
          accessibilityLabel="Search T3 tools"
          placeholder="Search tools, e.g. t3_thread_send"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          className="rounded-xl border border-border p-3 text-foreground"
        />
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Select a connected environment.</Text>
        ) : (
          selectedTargets.map((environment) => {
            const tools = environment.serverConfig.nativeTools;
            const visible = tools?.filter((tool) =>
              `${tool.name} ${tool.description}`.toLowerCase().includes(query),
            );
            return (
              <SettingsSection key={environment.environmentId} title={environment.label}>
                {tools === undefined ? (
                  <Text className="p-4 text-foreground-muted">
                    Update this environment to manage T3 tools.
                  </Text>
                ) : visible?.length === 0 ? (
                  <Text className="p-4 text-foreground-muted">No matching tools.</Text>
                ) : (
                  visible?.map((tool) => (
                    <View key={tool.name}>
                      <SettingsSwitchRow
                        label={tool.name}
                        subtitle={tool.description}
                        value={
                          environment.serverConfig.settings.nativeToolEnabled[tool.name] !== false
                        }
                        disabled={
                          !writable.has(environment.environmentId) ||
                          isManagedSettingPath(
                            environment.serverConfig.managedPolicy,
                            `nativeToolEnabled.${tool.name}`,
                          )
                        }
                        onValueChange={(enabled) => {
                          void update({
                            environmentId: environment.environmentId,
                            input: { patch: { nativeToolEnabled: { [tool.name]: enabled } } },
                          });
                        }}
                      />
                    </View>
                  ))
                )}
              </SettingsSection>
            );
          })
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
