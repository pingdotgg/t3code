import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsExtensionsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Extensions" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Use the filter above to select a connected environment.
            </Text>
          ) : (
            selectedTargets.map((target) => (
              <EnvironmentExtensions
                key={target.environmentId}
                environmentId={target.environmentId}
                label={target.label}
              />
            ))
          )}
          <Text className="px-2 text-sm text-foreground-muted">
            Install and manage extensions from Settings on web or desktop.
          </Text>
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentExtensions(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const { data, error } = useEnvironmentQuery(
    serverEnvironment.extensionsState({ environmentId: props.environmentId, input: {} }),
  );
  const extensions = data?.extensions ?? [];
  const message =
    data === null
      ? (error ?? "Loading extensions…")
      : extensions.length === 0
        ? "No extensions installed."
        : null;

  return (
    <SettingsSection title={props.label}>
      {message !== null ? (
        <Text className="p-4 text-base text-foreground-muted">{message}</Text>
      ) : (
        extensions.map((extension, index) => (
          <View
            key={extension.id}
            className={
              index === 0
                ? "flex-row items-center gap-4 p-4"
                : "flex-row items-center gap-4 border-t border-border-subtle p-4"
            }
          >
            <View className="min-w-0 flex-1 gap-1">
              <Text className="text-lg text-foreground" numberOfLines={1}>
                {extension.displayName}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {extension.publisher} · v{extension.version}
              </Text>
            </View>
            <Text className="text-sm text-foreground-muted">
              {extension.enabled ? "Enabled" : "Disabled"}
            </Text>
          </View>
        ))
      )}
    </SettingsSection>
  );
}
