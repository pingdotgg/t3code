import { T, useGT } from "gt-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { BlenderEnvironmentSettings } from "./BlenderEnvironmentSettings";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

/** Integrations are per machine, so the page edits exactly one environment from the filter. */
export function SettingsIntegrationsRouteScreen() {
  const gt = useGT();
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const [environment, ...others] = selectedTargets;
  return (
    <SettingsScreen title={gt("Integrations")} menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!environment ? (
          <Text className="text-foreground-muted">
            <T>Select a connected environment.</T>
          </Text>
        ) : others.length > 0 ? (
          <Text className="text-foreground-muted">
            <T>Select one environment in the filter.</T>
          </Text>
        ) : (
          <BlenderEnvironmentSettings
            key={environment.environmentId}
            environmentId={environment.environmentId}
            settings={environment.serverConfig.settings.blender}
          />
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
