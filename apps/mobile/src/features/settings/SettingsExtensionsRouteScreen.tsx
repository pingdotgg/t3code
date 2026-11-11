import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { extensionEnvironment } from "../../state/extensions";
import { useEnvironmentQuery } from "../../state/query";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { MobileExtensionCard } from "./MobileExtensionCard";
import { MobileExtensionInstallForm } from "./MobileExtensionInstallForm";

export function SettingsExtensionsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environmentMenu = useSettingsEnvironmentMenu();
  return (
    <SettingsScreen title="Extensions" menus={[environmentMenu]}>
      <ScreenScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-6 p-4">
          <Text className="text-sm leading-5 text-foreground-muted">
            Add tools, commands, and custom views to T3 Code. Extensions run on the selected server
            and are available on your connected devices.
          </Text>
          {selectedTargets.length === 0 && (
            <Text className="text-sm text-foreground-muted">
              Connect to an environment to manage its extensions.
            </Text>
          )}
          {selectedTargets.map((target) => (
            <MobileExtensionManager
              key={target.environmentId}
              environmentId={target.environmentId}
              label={target.label}
              serverConfig={target.serverConfig}
            />
          ))}
        </View>
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function MobileExtensionManager({
  environmentId,
  label,
  serverConfig,
}: {
  environmentId: EnvironmentId;
  label: string;
  serverConfig: Pick<ServerConfig, "environment" | "settings">;
}) {
  const supported = serverConfig.environment.capabilities.extensions === true;
  const query = useEnvironmentQuery(
    supported ? extensionEnvironment.state({ environmentId, input: {} }) : null,
  );
  const permission = useAtomValue(extensionEnvironment.install.permissionAtom(environmentId));
  const [adding, setAdding] = useState<boolean | null>(null);
  if (!supported) return <Text>Update T3 Code on {label} to use extensions.</Text>;
  const entries = query.data ?? [];
  const showInstall = adding ?? (entries.length === 0 && query.data !== null);
  return (
    <View className="gap-4">
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-t3-semibold" numberOfLines={1}>
            {label}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {entries.length} installed,{" "}
            {entries.filter((entry) => entry.status === "running").length} running
          </Text>
        </View>
        <Button
          label={showInstall ? "Cancel" : "Add extension"}
          icon={showInstall ? "xmark" : "plus"}
          size="compact"
          disabled={!permission}
          onPress={() => setAdding(!showInstall)}
        />
      </View>
      {showInstall && (
        <MobileExtensionInstallForm
          environmentId={environmentId}
          baseDirectory={serverConfig.settings.addProjectBaseDirectory}
          platform={serverConfig.environment.platform.os}
          onInstalled={() => setAdding(false)}
        />
      )}
      {query.error && (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {query.error}
        </Text>
      )}
      {query.isPending && !query.data && (
        <Text className="text-sm text-foreground-muted">Loading extensions...</Text>
      )}
      {query.data?.length === 0 && (
        <View className="gap-1 py-3">
          <Text className="font-t3-semibold">Your extensions will appear here</Text>
          <Text className="text-sm leading-5 text-foreground-muted">
            Install a folder from this server or an npm package to get started.
          </Text>
        </View>
      )}
      {entries.map((entry) => (
        <MobileExtensionCard key={entry.manifest.id} environmentId={environmentId} entry={entry} />
      ))}
    </View>
  );
}
